const DAY_MS = 86_400_000;
const RETURN_DAYS = [1, 7, 30];
const HASH = /^[0-9a-f]{16}$/;

export class RetentionInputError extends Error {}
export class RetentionCapacityError extends Error {}

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

export class RetentionLedger {
  constructor({ store, settings }) {
    this.store = store;
    this.settings = settings;
    this.project = store.database.prepare('SELECT * FROM retention_projects WHERE project = ?');
    this.insertProject = store.database.prepare(
      'INSERT INTO retention_projects(project, salt_hash, user_count) VALUES (?, ?, 0)'
    );
    this.incrementUsers = store.database.prepare(
      'UPDATE retention_projects SET user_count = user_count + 1 WHERE project = ?'
    );
    this.user = store.database.prepare('SELECT * FROM retention_users WHERE project = ? AND subject_hash = ?');
    this.putUser = store.database.prepare(`
      INSERT INTO retention_users(project, subject_hash, cohort_day, activity_days) VALUES (?, ?, ?, ?)
      ON CONFLICT(project, subject_hash) DO UPDATE SET
        cohort_day = excluded.cohort_day, activity_days = excluded.activity_days
    `);
    this.cohorts = store.database.prepare(`
      SELECT cohort_day, COUNT(*) AS users,
        SUM((activity_days & 2) != 0) AS d1,
        SUM((activity_days & 128) != 0) AS d7,
        SUM((activity_days & 1073741824) != 0) AS d30
      FROM retention_users
      WHERE project = ? AND cohort_day >= ? AND cohort_day < ?
      GROUP BY cohort_day ORDER BY cohort_day
    `);
  }

  ingestBatch(project, events) {
    if (events.length === 0) return;
    return this.store.transaction(() => {
      let state = this.project.get(project);
      for (const { timestamp, subject, salt } of events) {
        if (!HASH.test(subject) || !HASH.test(salt) || !Number.isSafeInteger(timestamp) || timestamp < 0) {
          throw new RetentionInputError('invalid retention activity');
        }
        if (!state) {
          this.insertProject.run(project, salt);
          state = { salt_hash: salt, user_count: 0 };
        }
        if (state.salt_hash !== salt) {
          throw new RetentionInputError('retention PrivacySalt must remain stable across project clients');
        }
        const hash = Buffer.from(subject, 'hex');
        const current = this.user.get(project, hash);
        const day = Math.floor(timestamp / DAY_MS);
        let cohort = day;
        let activity = 1;
        if (current) {
          cohort = Math.min(day, current.cohort_day);
          const shift = current.cohort_day - cohort;
          // Keep every day through D30 so earlier, delayed activity can correct the cohort.
          activity = shift > 30 ? 0 : Number((BigInt(current.activity_days) << BigInt(shift)) & 0x7fffffffn);
          const offset = day - cohort;
          if (offset <= 30) activity |= 2 ** offset;
          if (cohort === current.cohort_day && activity === current.activity_days) continue;
        } else {
          if (state.user_count >= this.settings.maxUsersPerProject) {
            throw new RetentionCapacityError('retention user capacity reached');
          }
          this.incrementUsers.run(project);
          state.user_count += 1;
        }
        this.putUser.run(project, hash, cohort, activity);
      }
    });
  }

  query(project, { from, to }, now = Date.now()) {
    const first = dateDay(from);
    const end = dateDay(to);
    if (end <= first || end - first > this.settings.maxQueryDays) {
      throw new RetentionInputError(`cohort range must span 1 to ${this.settings.maxQueryDays} days; to is exclusive`);
    }
    const today = Math.floor(now / DAY_MS);
    return {
      project, from, to, timezone: 'UTC', mode: 'on_day', exact: true,
      basis: 'received_activity',
      cohorts: this.cohorts.all(project, first, end).map((row) => ({
        cohort: new Date(row.cohort_day * DAY_MS).toISOString().slice(0, 10),
        users: row.users,
        returns: RETURN_DAYS.map((day) => {
          const mature = today > row.cohort_day + day;
          return {
            day, status: mature ? 'mature' : 'pending',
            users: mature ? row[`d${day}`] : null,
            rate: mature ? row[`d${day}`] / row.users : null
          };
        })
      }))
    };
  }
}
