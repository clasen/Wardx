const DAY_MS = 86_400_000;
const RETURN_DAYS = [1, 7, 30];
const HASH = /^[0-9a-f]{16}$/;
const LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// Users whose first touch named a channel beyond maxChannelsPerProject. The
// parentheses keep it apart from every client label.
const OVER_CAP = '(over_cap)';

export class RetentionInputError extends Error {}

function dateDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RetentionInputError('cohort dates must be YYYY-MM-DD');
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new RetentionInputError('invalid cohort date');
  }
  return timestamp / DAY_MS;
}

function optionalLabel(value, name, reserved) {
  if (value !== undefined && value !== reserved && (typeof value !== 'string' || !LABEL.test(value))) {
    throw new RetentionInputError(`${name} must match ${LABEL}`);
  }
  return value;
}

function cohortQuery(byChannel) {
  const groups = byChannel ? 'u.cohort_day, uc.channel' : 'u.cohort_day';
  return `
    SELECT u.cohort_day, ${byChannel ? 'uc.channel' : 'NULL'} AS channel, COUNT(*) AS users,
      SUM((u.activity_days & 2) != 0) AS d1,
      SUM((u.activity_days & 128) != 0) AS d7,
      SUM((u.activity_days & 1073741824) != 0) AS d30,
      SUM(ifnull(c.conversion_day <= u.cohort_day + 1, 0)) AS c1,
      SUM(ifnull(c.conversion_day <= u.cohort_day + 7, 0)) AS c7,
      SUM(ifnull(c.conversion_day <= u.cohort_day + 30, 0)) AS c30,
      SUM(ifnull(c.duplicates, 0)) AS duplicates
    FROM retention_users u
    LEFT JOIN retention_user_channels uc ON uc.project = u.project AND uc.subject_hash = u.subject_hash
    LEFT JOIN retention_conversions c ON c.project = u.project AND c.subject_hash = u.subject_hash AND c.goal = @goal
    WHERE u.project = @project AND u.cohort_day >= @first AND u.cohort_day < @end
      AND (@channel IS NULL OR uc.channel = @channel)
    GROUP BY ${groups} ORDER BY ${groups}
  `;
}

export class RetentionLedger {
  constructor({ store, settings }) {
    this.store = store;
    this.settings = settings;
    const database = store.database;
    this.project = database.prepare('SELECT * FROM retention_projects WHERE project = ?');
    this.insertProject = database.prepare(
      'INSERT INTO retention_projects(project, salt_hash, user_count) VALUES (?, ?, 0)'
    );
    this.incrementUsers = database.prepare(
      'UPDATE retention_projects SET user_count = user_count + 1 WHERE project = ?'
    );
    this.addDropped = database.prepare(`
      UPDATE retention_projects SET
        dropped_activity = dropped_activity + ?, dropped_conversions = dropped_conversions + ?
      WHERE project = ?
    `);
    this.user = database.prepare('SELECT * FROM retention_users WHERE project = ? AND subject_hash = ?');
    this.putUser = database.prepare(`
      INSERT INTO retention_users(project, subject_hash, cohort_day, activity_days) VALUES (?, ?, ?, ?)
      ON CONFLICT(project, subject_hash) DO UPDATE SET
        cohort_day = excluded.cohort_day, activity_days = excluded.activity_days
    `);
    this.label = database.prepare('SELECT 1 FROM retention_labels WHERE project = ? AND kind = ? AND label = ?');
    this.labelCount = database.prepare('SELECT COUNT(*) AS count FROM retention_labels WHERE project = ? AND kind = ?');
    this.insertLabel = database.prepare('INSERT INTO retention_labels(project, kind, label) VALUES (?, ?, ?)');
    this.userChannel = database.prepare(
      'SELECT channel, touched_at FROM retention_user_channels WHERE project = ? AND subject_hash = ?'
    );
    this.putUserChannel = database.prepare(`
      INSERT INTO retention_user_channels(project, subject_hash, channel, touched_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(project, subject_hash) DO UPDATE SET
        channel = excluded.channel, touched_at = excluded.touched_at
    `);
    this.conversion = database.prepare(
      'SELECT conversion_day FROM retention_conversions WHERE project = ? AND subject_hash = ? AND goal = ?'
    );
    this.anyConversion = database.prepare(
      'SELECT 1 FROM retention_conversions WHERE project = ? AND subject_hash = ? LIMIT 1'
    );
    this.insertConversion = database.prepare(
      'INSERT INTO retention_conversions(project, subject_hash, goal, conversion_day) VALUES (?, ?, ?, ?)'
    );
    this.repeatConversion = database.prepare(`
      UPDATE retention_conversions SET conversion_day = min(conversion_day, ?), duplicates = duplicates + 1
      WHERE project = ? AND subject_hash = ? AND goal = ?
    `);
    this.orphans = database.prepare(`
      SELECT COUNT(*) AS count FROM retention_conversions c
      WHERE c.project = @project AND c.goal = @goal AND c.conversion_day >= @first AND c.conversion_day < @end
        AND NOT EXISTS (
          SELECT 1 FROM retention_users u WHERE u.project = c.project AND u.subject_hash = c.subject_hash
        )
    `);
    this.cohorts = database.prepare(cohortQuery(false));
    this.channelCohorts = database.prepare(cohortQuery(true));
  }

  // Accepts activity ({ timestamp, subject, salt, channel? }) and conversions
  // ({ timestamp, subject, salt, goal }). Returns how many activities and
  // conversions from unknown subjects were dropped at maxUsersPerProject, how
  // many conversions named a goal beyond maxGoalsPerProject, and how many
  // first touches named a channel beyond maxChannelsPerProject and were kept
  // as (over_cap); known subjects keep updating. Activity and conversion drops
  // also persist per project.
  ingestBatch(project, events) {
    const dropped = { activity: 0, conversions: 0, channels: 0 };
    if (events.length === 0) return dropped;
    return this.store.transaction(() => {
      let state = this.project.get(project);
      for (const event of events) {
        const { timestamp, subject, salt, channel, goal } = event;
        if (!HASH.test(subject) || !HASH.test(salt) || !Number.isSafeInteger(timestamp) || timestamp < 0) {
          throw new RetentionInputError('invalid retention activity');
        }
        if ((channel !== undefined && !LABEL.test(channel)) || (goal !== undefined && !LABEL.test(goal))) {
          throw new RetentionInputError('invalid retention label');
        }
        if (!state) {
          this.insertProject.run(project, salt);
          state = { salt_hash: salt, user_count: 0 };
        }
        if (state.salt_hash !== salt) {
          throw new RetentionInputError('retention PrivacySalt must remain stable across project clients');
        }
        const hash = Buffer.from(subject, 'hex');
        const day = Math.floor(timestamp / DAY_MS);
        if (goal !== undefined) this._conversion(project, state, hash, day, goal, dropped);
        else this._activity(project, state, hash, day, timestamp, channel, dropped);
      }
      if (dropped.activity > 0 || dropped.conversions > 0) {
        this.addDropped.run(dropped.activity, dropped.conversions, project);
      }
      return dropped;
    });
  }

  _activity(project, state, hash, day, timestamp, channel, dropped) {
    const current = this.user.get(project, hash);
    if (!current && !this.anyConversion.get(project, hash) && !this._admit(project, state)) {
      dropped.activity += 1;
      return;
    }
    let cohort = day;
    let activity = 1;
    if (current) {
      cohort = Math.min(day, current.cohort_day);
      const shift = current.cohort_day - cohort;
      // Keep every day through D30 so earlier, delayed activity can correct the cohort.
      activity = shift > 30 ? 0 : Number((BigInt(current.activity_days) << BigInt(shift)) & 0x7fffffffn);
      const offset = day - cohort;
      if (offset <= 30) activity |= 2 ** offset;
    }
    if (!current || cohort !== current.cohort_day || activity !== current.activity_days) {
      this.putUser.run(project, hash, cohort, activity);
    }
    if (channel === undefined) return;
    // First touch: the earliest channel-bearing activity wins, ties by label, in any arrival order.
    const touch = this.userChannel.get(project, hash);
    if (touch && (touch.touched_at < timestamp || (touch.touched_at === timestamp && touch.channel <= channel))) return;
    let label = channel;
    if (!this._registerLabel(project, 'channel', channel, this.settings.maxChannelsPerProject)) {
      dropped.channels += 1;
      label = OVER_CAP;
    }
    this.putUserChannel.run(project, hash, label, timestamp);
  }

  _conversion(project, state, hash, day, goal, dropped) {
    const known = this.user.get(project, hash) !== undefined || this.anyConversion.get(project, hash) !== undefined;
    if ((!known && state.user_count >= this.settings.maxUsersPerProject)
      || !this._registerLabel(project, 'goal', goal, this.settings.maxGoalsPerProject)) {
      dropped.conversions += 1;
      return;
    }
    if (!known) this._admit(project, state);
    // One conversion per user and goal: repeats keep the earliest day and are counted.
    if (this.conversion.get(project, hash, goal)) this.repeatConversion.run(day, project, hash, goal);
    else this.insertConversion.run(project, hash, goal, day);
  }

  // Counts a new subject toward capacity. A subject first seen through a
  // conversion was already counted when its activity arrives.
  _admit(project, state) {
    if (state.user_count >= this.settings.maxUsersPerProject) return false;
    this.incrementUsers.run(project);
    state.user_count += 1;
    return true;
  }

  _registerLabel(project, kind, label, limit) {
    if (this.label.get(project, kind, label)) return true;
    if (this.labelCount.get(project, kind).count >= limit) return false;
    this.insertLabel.run(project, kind, label);
    return true;
  }

  query(project, { from, to, goal, byChannel, channel }, now = Date.now()) {
    const first = dateDay(from);
    const end = dateDay(to);
    if (end <= first || end - first > this.settings.maxQueryDays) {
      throw new RetentionInputError(`cohort range must span 1 to ${this.settings.maxQueryDays} days; to is exclusive`);
    }
    optionalLabel(goal, 'goal');
    optionalLabel(channel, 'channel', OVER_CAP);
    if (byChannel !== undefined && typeof byChannel !== 'boolean') {
      throw new RetentionInputError('byChannel must be a boolean');
    }
    const grouped = byChannel === true || channel !== undefined;
    const today = Math.floor(now / DAY_MS);
    const horizon = (row, prefix) => RETURN_DAYS.map((day) => {
      const mature = today > row.cohort_day + day;
      const users = row[`${prefix}${day}`];
      return {
        day, status: mature ? 'mature' : 'pending',
        users: mature ? users : null,
        rate: mature ? users / row.users : null
      };
    });
    const rows = (grouped ? this.channelCohorts : this.cohorts).all({
      project, first, end, goal: goal ?? null, channel: channel ?? null
    });
    return {
      project, from, to, timezone: 'UTC', mode: 'on_day', exact: true,
      basis: 'received_activity',
      ...(grouped ? { attribution: 'first_touch' } : {}),
      ...(goal === undefined ? {} : {
        goal, conversionMode: 'by_day',
        orphanConversions: this.orphans.get({ project, goal, first, end }).count
      }),
      capacity: this._capacity(project),
      cohorts: rows.map((row) => ({
        cohort: new Date(row.cohort_day * DAY_MS).toISOString().slice(0, 10),
        ...(grouped ? { channel: row.channel } : {}),
        users: row.users,
        returns: horizon(row, 'd'),
        ...(goal === undefined ? {} : { conversions: horizon(row, 'c'), duplicateConversions: row.duplicates })
      }))
    };
  }

  _capacity(project) {
    const state = this.project.get(project);
    return {
      users: state?.user_count ?? 0,
      maxUsers: this.settings.maxUsersPerProject,
      channels: this.labelCount.get(project, 'channel').count,
      maxChannels: this.settings.maxChannelsPerProject,
      goals: this.labelCount.get(project, 'goal').count,
      maxGoals: this.settings.maxGoalsPerProject,
      droppedActivity: state?.dropped_activity ?? 0,
      droppedConversions: state?.dropped_conversions ?? 0
    };
  }
}
