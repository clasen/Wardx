import Database from 'better-sqlite3';
import { assertHistoryBoundary } from '../aggregation/history/HistoryBucket.js';

const SCHEMA_VERSION = 2;
const RETENTION_SCHEMA = `
  CREATE TABLE retention_projects (
    project TEXT PRIMARY KEY,
    salt_hash TEXT NOT NULL,
    user_count INTEGER NOT NULL CHECK (user_count >= 0)
  ) STRICT;
  CREATE TABLE retention_users (
    project TEXT NOT NULL,
    subject_hash BLOB NOT NULL CHECK (length(subject_hash) = 32),
    cohort_day INTEGER NOT NULL CHECK (cohort_day >= 0),
    activity_days INTEGER NOT NULL CHECK (activity_days BETWEEN 1 AND 2147483647),
    PRIMARY KEY(project, subject_hash)
  ) STRICT;
  CREATE INDEX retention_cohorts ON retention_users(project, cohort_day);
`;
const TIERS = new Set(['minute', 'hour', 'day']);
const TABLE_BY_TIER = Object.freeze({
  minute: 'minute_aggregates',
  hour: 'hour_aggregates',
  day: 'day_aggregates'
});
const WIDTH_BY_TIER = Object.freeze({ minute: 60_000, hour: 3_600_000, day: 86_400_000 });
const SYNCHRONOUS = new Set(['OFF', 'NORMAL', 'FULL', 'EXTRA']);
const CHECKPOINT_MODES = new Set(['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE']);
const REQUIRED_SETTINGS = [
  'synchronous',
  'busyTimeoutMs',
  'walAutoCheckpointPages',
  'checkpointMode',
  'maxWriteBatch',
  'transactionTimeoutMs',
  'maxHistoryBuckets',
  'maxHistoryRows'
];
const REQUIRED_TABLES = [
  'compaction_watermarks',
  'day_aggregates',
  'experiment_assignment_ledger',
  'experiment_terminal_decisions',
  'experiment_totals',
  'hour_aggregates',
  'minute_aggregates',
  'mutation_journal',
  'project_state',
  'retention_projects',
  'retention_users',
  'schema_metadata'
];

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be an integer >= 1`);
}

function validateSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('SQLite settings are required');
  }
  for (const name of REQUIRED_SETTINGS) {
    if (!Object.prototype.hasOwnProperty.call(settings, name)) throw new Error(`SQLite setting ${name} is required`);
  }
  const synchronous = String(settings.synchronous).toUpperCase();
  if (!SYNCHRONOUS.has(synchronous)) {
    throw new Error('SQLite setting synchronous must be OFF, NORMAL, FULL, or EXTRA');
  }
  const checkpointMode = String(settings.checkpointMode).toUpperCase();
  if (!CHECKPOINT_MODES.has(checkpointMode)) {
    throw new Error('SQLite setting checkpointMode must be PASSIVE, FULL, RESTART, or TRUNCATE');
  }
  for (const name of [
    'busyTimeoutMs',
    'walAutoCheckpointPages',
    'maxWriteBatch',
    'transactionTimeoutMs',
    'maxHistoryBuckets',
    'maxHistoryRows'
  ]) {
    requirePositiveInteger(settings[name], `SQLite setting ${name}`);
  }
  return { ...settings, synchronous, checkpointMode };
}

function tableForTier(tier) {
  if (!TIERS.has(tier)) throw new Error('tier must be minute, hour, or day');
  return TABLE_BY_TIER[tier];
}

function parseJson(value) {
  return JSON.parse(value);
}

function serializeJson(value, label) {
  if (value === undefined) throw new Error(`${label} is required`);
  return JSON.stringify(value);
}

function validateBucket(bucket, tier) {
  if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) throw new Error('bucket must be an object');
  requireNonEmptyString(bucket.project, 'bucket.project');
  if (bucket.tier !== undefined && bucket.tier !== tier) throw new Error(`bucket.tier must be ${tier}`);
  if (!Number.isInteger(bucket.from) || !Number.isInteger(bucket.to) || bucket.to <= bucket.from) {
    throw new Error('bucket.from and bucket.to must be integer timestamps with to > from');
  }
  assertHistoryBoundary(tier, bucket.from, bucket.to);
  if (!Array.isArray(bucket.rows)) throw new Error('bucket.rows must be an array');
  if (typeof bucket.finalized !== 'boolean') throw new Error('bucket.finalized must be a boolean');
  if (!Number.isInteger(bucket.dropCount) || bucket.dropCount < 0) {
    throw new Error('bucket.dropCount must be an integer >= 0');
  }
}

function storedBucket(row, tier) {
  return {
    project: row.project,
    tier,
    from: row.bucket_from,
    to: row.bucket_to,
    finalized: row.finalized === 1,
    dropCount: row.drop_count,
    rows: parseJson(row.rows_json)
  };
}

function tableNames(database) {
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
}

export function validateSqliteSchema(database, expectedVersion = SCHEMA_VERSION) {
  const version = database.pragma('user_version', { simple: true });
  if (version !== expectedVersion) {
    throw new Error(`incompatible SQLite schema version ${version}; expected ${expectedVersion}`);
  }
  const requiredTables = expectedVersion === 1
    ? REQUIRED_TABLES.filter((name) => !name.startsWith('retention_'))
    : REQUIRED_TABLES;
  if (JSON.stringify(tableNames(database)) !== JSON.stringify(requiredTables)) {
    throw new Error(`incompatible SQLite schema tables for version ${expectedVersion}`);
  }
  const metadata = database.prepare('SELECT version FROM schema_metadata WHERE singleton = 1').get();
  if (!metadata || metadata.version !== expectedVersion) {
    throw new Error(`incompatible SQLite schema metadata for version ${expectedVersion}`);
  }
}

export class SqliteStateStore {
  static SCHEMA_VERSION = SCHEMA_VERSION;

  constructor({ path, settings }) {
    requireNonEmptyString(path, 'SQLite path');
    this.settings = validateSettings(settings);
    this.metrics = {
      transactions: 0,
      transactionFailures: 0,
      busyFailures: 0,
      transactionLatencyTotalMs: 0,
      transactionLatencyMaxMs: 0,
      checkpoints: 0,
      checkpointBusy: 0,
      checkpointLogFrames: 0,
      checkpointedFrames: 0,
      checkpointFailures: 0,
      checkpointLatencyTotalMs: 0,
      checkpointLatencyMaxMs: 0,
      optimizations: 0,
      optimizationFailures: 0,
      optimizationLatencyTotalMs: 0,
      optimizationLatencyMaxMs: 0
    };
    this.database = new Database(path, { timeout: this.settings.busyTimeoutMs });
    try {
      this.database.pragma(`busy_timeout = ${this.settings.busyTimeoutMs}`);
      const journalMode = String(this.database.pragma('journal_mode = WAL', { simple: true })).toLowerCase();
      if (journalMode !== 'wal') throw new Error(`SQLite WAL mode unavailable: ${journalMode}`);
      this.database.pragma(`synchronous = ${this.settings.synchronous}`);
      this.database.pragma(`wal_autocheckpoint = ${this.settings.walAutoCheckpointPages}`);
      this._initializeSchema();
      this._validateSchema();
      this._prepareStatements();
      this.optimize(true);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  _initializeSchema() {
    const version = this.database.pragma('user_version', { simple: true });
    if (version === 1) {
      validateSqliteSchema(this.database, 1);
      this.database.transaction(() => {
        this.database.exec(RETENTION_SCHEMA);
        this.database.exec(`UPDATE schema_metadata SET version = ${SCHEMA_VERSION} WHERE singleton = 1`);
        this.database.pragma(`user_version = ${SCHEMA_VERSION}`);
      }).immediate();
      return;
    }
    if (version !== 0 && version !== SCHEMA_VERSION) {
      throw new Error(`incompatible SQLite schema version ${version}; expected ${SCHEMA_VERSION}`);
    }
    if (version === SCHEMA_VERSION) return;
    const existing = this.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all();
    if (existing.length > 0) throw new Error('incompatible unversioned SQLite schema');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec(`
        CREATE TABLE schema_metadata (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          version INTEGER NOT NULL
        ) STRICT;
        INSERT INTO schema_metadata(singleton, version) VALUES (1, ${SCHEMA_VERSION});

        CREATE TABLE project_state (
          project TEXT PRIMARY KEY,
          version INTEGER NOT NULL,
          state_json TEXT NOT NULL,
          catalog_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE mutation_journal (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project TEXT NOT NULL,
          previous_version INTEGER NOT NULL,
          new_version INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          entry_json TEXT NOT NULL,
          UNIQUE(project, new_version)
        ) STRICT;

        CREATE TABLE minute_aggregates (
          project TEXT NOT NULL,
          bucket_from INTEGER NOT NULL,
          bucket_to INTEGER NOT NULL,
          finalized INTEGER NOT NULL CHECK (finalized IN (0, 1)),
          drop_count INTEGER NOT NULL CHECK (drop_count >= 0),
          rows_json TEXT NOT NULL,
          PRIMARY KEY(project, bucket_from)
        ) STRICT;
        CREATE TABLE hour_aggregates (
          project TEXT NOT NULL,
          bucket_from INTEGER NOT NULL,
          bucket_to INTEGER NOT NULL,
          finalized INTEGER NOT NULL CHECK (finalized IN (0, 1)),
          drop_count INTEGER NOT NULL CHECK (drop_count >= 0),
          rows_json TEXT NOT NULL,
          PRIMARY KEY(project, bucket_from)
        ) STRICT;
        CREATE TABLE day_aggregates (
          project TEXT NOT NULL,
          bucket_from INTEGER NOT NULL,
          bucket_to INTEGER NOT NULL,
          finalized INTEGER NOT NULL CHECK (finalized IN (0, 1)),
          drop_count INTEGER NOT NULL CHECK (drop_count >= 0),
          rows_json TEXT NOT NULL,
          PRIMARY KEY(project, bucket_from)
        ) STRICT;

        CREATE TABLE compaction_watermarks (
          project TEXT NOT NULL,
          source_tier TEXT NOT NULL CHECK (source_tier IN ('minute', 'hour')),
          destination_tier TEXT NOT NULL CHECK (destination_tier IN ('hour', 'day')),
          source_through INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(project, source_tier, destination_tier)
        ) STRICT;

        CREATE TABLE experiment_assignment_ledger (
          project TEXT NOT NULL,
          experiment TEXT NOT NULL,
          assignment_hash BLOB NOT NULL CHECK (length(assignment_hash) = 32),
          variant TEXT NOT NULL,
          exposure_json TEXT NOT NULL,
          goal_json TEXT,
          source_role TEXT NOT NULL,
          trust_class TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          PRIMARY KEY(project, experiment, assignment_hash)
        ) STRICT;

        CREATE TABLE experiment_totals (
          project TEXT NOT NULL,
          experiment TEXT NOT NULL,
          variant TEXT NOT NULL,
          source_role TEXT NOT NULL,
          trust_class TEXT NOT NULL,
          totals_json TEXT NOT NULL,
          PRIMARY KEY(project, experiment, variant, source_role, trust_class)
        ) STRICT;

        CREATE TABLE experiment_terminal_decisions (
          project TEXT NOT NULL,
          experiment TEXT NOT NULL,
          decided_at INTEGER NOT NULL,
          decision_json TEXT NOT NULL,
          PRIMARY KEY(project, experiment)
        ) STRICT;

        ${RETENTION_SCHEMA}
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  _validateSchema() {
    validateSqliteSchema(this.database);
  }

  _prepareStatements() {
    this.upsertProject = this.database.prepare(`
      INSERT INTO project_state(project, version, state_json, catalog_json, updated_at)
      VALUES (@project, @version, @stateJson, @catalogJson, @updatedAt)
      ON CONFLICT(project) DO UPDATE SET
        version = excluded.version,
        state_json = excluded.state_json,
        catalog_json = excluded.catalog_json,
        updated_at = excluded.updated_at
    `);
    this.insertJournal = this.database.prepare(`
      INSERT INTO mutation_journal(project, previous_version, new_version, created_at, entry_json)
      VALUES (@project, @previousVersion, @newVersion, @createdAt, @entryJson)
    `);
  }

  _transaction(work) {
    const started = process.hrtime.bigint();
    try {
      const result = this.database.transaction(() => {
        const value = work();
        const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
        if (elapsedMs > this.settings.transactionTimeoutMs) {
          throw new Error(`SQLite transaction exceeded ${this.settings.transactionTimeoutMs}ms`);
        }
        return value;
      }).immediate();
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      this.metrics.transactions += 1;
      this.metrics.transactionLatencyTotalMs += elapsedMs;
      if (elapsedMs > this.metrics.transactionLatencyMaxMs) this.metrics.transactionLatencyMaxMs = elapsedMs;
      return result;
    } catch (error) {
      this.metrics.transactionFailures += 1;
      if (error?.code === 'SQLITE_BUSY') this.metrics.busyFailures += 1;
      throw error;
    }
  }

  transaction(work) {
    if (typeof work !== 'function') throw new Error('transaction work must be a function');
    return this._transaction(() => work(this));
  }

  schemaVersion() {
    return this.database.pragma('user_version', { simple: true });
  }

  saveProjectState({ project, version, state, catalog, updatedAt = Date.now() }) {
    requireNonEmptyString(project, 'project');
    if (!Number.isInteger(version) || version < 0) throw new Error('version must be an integer >= 0');
    this.upsertProject.run({
      project,
      version,
      stateJson: serializeJson(state, 'state'),
      catalogJson: serializeJson(catalog, 'catalog'),
      updatedAt
    });
  }

  readProjectState(project) {
    requireNonEmptyString(project, 'project');
    const row = this.database.prepare('SELECT * FROM project_state WHERE project = ?').get(project);
    if (!row) return null;
    return {
      project: row.project,
      version: row.version,
      state: parseJson(row.state_json),
      catalog: parseJson(row.catalog_json),
      updatedAt: row.updated_at
    };
  }

  commitProjectMutation({
    project,
    previousVersion,
    newVersion,
    state,
    catalog,
    entry,
    journalCapacity,
    createdAt = Date.now()
  }) {
    requireNonEmptyString(project, 'project');
    if (!Number.isInteger(previousVersion) || !Number.isInteger(newVersion) || newVersion <= previousVersion) {
      throw new Error('mutation versions must be integers with newVersion > previousVersion');
    }
    return this._transaction(() => {
      const current = this.database.prepare('SELECT version FROM project_state WHERE project = ?').get(project);
      if (current && current.version !== previousVersion) {
        throw new Error(`project version conflict: current version is ${current.version}`);
      }
      this.saveProjectState({ project, version: newVersion, state, catalog, updatedAt: createdAt });
      const result = this.insertJournal.run({
        project,
        previousVersion,
        newVersion,
        createdAt,
        entryJson: serializeJson(entry, 'entry')
      });
      if (journalCapacity !== undefined) {
        requirePositiveInteger(journalCapacity, 'journalCapacity');
        this.database.prepare(`
          DELETE FROM mutation_journal
          WHERE project = ? AND id NOT IN (
            SELECT id FROM mutation_journal WHERE project = ? ORDER BY id DESC LIMIT ?
          )
        `).run(project, project, journalCapacity);
      }
      return { journalId: Number(result.lastInsertRowid), version: newVersion };
    });
  }

  listJournal(project, { afterId = 0, limit } = {}) {
    requireNonEmptyString(project, 'project');
    requirePositiveInteger(limit, 'journal limit');
    if (limit > this.settings.maxHistoryRows) throw new Error('journal limit exceeds configured maximum');
    return this.database
      .prepare('SELECT * FROM mutation_journal WHERE project = ? AND id > ? ORDER BY id LIMIT ?')
      .all(project, afterId, limit)
      .map((row) => ({
        id: row.id,
        project: row.project,
        previousVersion: row.previous_version,
        newVersion: row.new_version,
        createdAt: row.created_at,
        entry: parseJson(row.entry_json)
      }));
  }

  saveBuckets(tier, buckets) {
    const table = tableForTier(tier);
    if (!Array.isArray(buckets)) throw new Error('buckets must be an array');
    if (buckets.length > this.settings.maxWriteBatch) throw new Error('bucket batch exceeds configured maximum');
    const statement = this.database.prepare(`
      INSERT INTO ${table}(project, bucket_from, bucket_to, finalized, drop_count, rows_json)
      VALUES (@project, @from, @to, @finalized, @dropCount, @rowsJson)
      ON CONFLICT(project, bucket_from) DO UPDATE SET
        bucket_to = excluded.bucket_to,
        finalized = excluded.finalized,
        drop_count = excluded.drop_count,
        rows_json = excluded.rows_json
    `);
    return this._transaction(() => {
      for (const bucket of buckets) {
        validateBucket(bucket, tier);
        this._assertHistoricalBucketMutable(tier, bucket);
        statement.run({
          project: bucket.project,
          from: bucket.from,
          to: bucket.to,
          finalized: bucket.finalized ? 1 : 0,
          dropCount: bucket.dropCount,
          rowsJson: serializeJson(bucket.rows, 'bucket.rows')
        });
      }
      return buckets.length;
    });
  }

  _assertHistoricalBucketMutable(tier, bucket) {
    if (tier === 'minute') return;
    const existing = this.readBucket(bucket.project, tier, bucket.from);
    if (!existing || !existing.finalized) return;
    const same =
      existing.project === bucket.project &&
      existing.tier === tier &&
      existing.from === bucket.from &&
      existing.to === bucket.to &&
      existing.finalized === bucket.finalized &&
      existing.dropCount === bucket.dropCount &&
      JSON.stringify(existing.rows) === JSON.stringify(bucket.rows);
    if (!same) {
      throw new Error('finalized historical buckets are immutable');
    }
  }

  readBucket(project, tier, from) {
    requireNonEmptyString(project, 'project');
    const table = tableForTier(tier);
    const row = this.database.prepare(`SELECT * FROM ${table} WHERE project = ? AND bucket_from = ?`).get(project, from);
    return row ? storedBucket(row, tier) : null;
  }

  readBuckets({ project, tier, from, to }) {
    requireNonEmptyString(project, 'project');
    const table = tableForTier(tier);
    if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) {
      throw new Error('bucket from and to must be bounded integer timestamps with to > from');
    }
    if (to - from > 86_400_000) throw new Error('internal bucket range cannot exceed one day');
    const rows = this.database
      .prepare(`SELECT * FROM ${table} WHERE project = ? AND bucket_from >= ? AND bucket_to <= ? ORDER BY bucket_from`)
      .all(project, from, to);
    return rows.map((row) => storedBucket(row, tier));
  }

  listBucketStarts({ project, tier, afterFrom = -1, limit }) {
    requireNonEmptyString(project, 'project');
    const table = tableForTier(tier);
    requirePositiveInteger(limit, 'bucket scan limit');
    if (limit > this.settings.maxWriteBatch) throw new Error('bucket scan limit exceeds configured maximum');
    if (!Number.isInteger(afterFrom)) throw new Error('bucket scan afterFrom must be an integer timestamp');
    return this.database
      .prepare(`SELECT bucket_from FROM ${table} WHERE project = ? AND bucket_from > ? ORDER BY bucket_from LIMIT ?`)
      .all(project, afterFrom, limit)
      .map((row) => row.bucket_from);
  }

  compactionStarts(project, sourceTier, destinationTier) {
    const source = tableForTier(sourceTier);
    const destination = tableForTier(destinationTier);
    const width = WIDTH_BY_TIER[destinationTier];
    return this.database.prepare(`
      SELECT DISTINCT CAST(source.bucket_from / ? AS INTEGER) * ? AS start
      FROM ${source} AS source
      WHERE source.project = ? AND NOT EXISTS (
        SELECT 1 FROM ${destination} AS destination
        WHERE destination.project = source.project AND destination.finalized = 1
          AND destination.bucket_from = CAST(source.bucket_from / ? AS INTEGER) * ?
      ) ORDER BY start
    `).all(width, width, project, width, width).map((row) => row.start);
  }

  finalizeBucketsThrough(project, tier, through) {
    requireNonEmptyString(project, 'project');
    const table = tableForTier(tier);
    if (!Number.isInteger(through)) throw new Error('finalization boundary must be an integer timestamp');
    return this._transaction(() =>
      this.database
        .prepare(`UPDATE ${table} SET finalized = 1 WHERE project = ? AND finalized = 0 AND bucket_to <= ?`)
        .run(project, through).changes
    );
  }

  pruneBuckets(project, tier, retentionCutoff) {
    requireNonEmptyString(project, 'project');
    const table = tableForTier(tier);
    if (!Number.isInteger(retentionCutoff)) throw new Error('retention cutoff must be an integer timestamp');
    return this._transaction(() => {
      let safeThrough = retentionCutoff;
      if (tier === 'minute' || tier === 'hour') {
        const destinationTier = tier === 'minute' ? 'hour' : 'day';
        const watermark = this.readWatermark(project, tier, destinationTier);
        if (watermark === null) return 0;
        safeThrough = Math.min(safeThrough, watermark);
        const destinationTable = tableForTier(destinationTier);
        return this.database
          .prepare(`
            DELETE FROM ${table} AS source
            WHERE source.project = ? AND source.finalized = 1 AND source.bucket_to <= ?
              AND EXISTS (
                SELECT 1 FROM ${destinationTable} AS destination
                WHERE destination.project = source.project AND destination.finalized = 1
                  AND destination.bucket_from <= source.bucket_from
                  AND destination.bucket_to >= source.bucket_to
              )
          `)
          .run(project, safeThrough).changes;
      }
      return this.database
        .prepare(`DELETE FROM ${table} WHERE project = ? AND finalized = 1 AND bucket_to <= ?`)
        .run(project, safeThrough).changes;
    });
  }

  queryHistory({ project, tier, from, to, role, environment, appVersion, names, limit }) {
    requireNonEmptyString(project, 'project');
    const table = tableForTier(tier);
    if (tier === 'minute') throw new Error('history tier must be hour or day');
    if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) {
      throw new Error('history from and to must be bounded integer timestamps with to > from');
    }
    const requestedBuckets = Math.ceil((to - from) / WIDTH_BY_TIER[tier]);
    if (requestedBuckets > this.settings.maxHistoryBuckets) {
      throw new Error('history range exceeds configured bucket maximum');
    }
    for (const [name, value] of Object.entries({ role, environment, appVersion })) {
      if (value !== undefined) requireNonEmptyString(value, `history ${name}`);
    }
    if (names !== undefined) {
      if (!Array.isArray(names)) throw new Error('history names must be an array');
      for (const name of names) requireNonEmptyString(name, 'history names item');
    }
    requirePositiveInteger(limit, 'history limit');
    if (limit > this.settings.maxHistoryRows) throw new Error('history limit exceeds configured maximum');
    const predicates = [];
    const parameters = [];
    for (const [field, value] of Object.entries({ role, environment, appVersion })) {
      if (value !== undefined) {
        predicates.push(`json_extract(value, '$.${field}') = ?`);
        parameters.push(value);
      }
    }
    if (names !== undefined) {
      predicates.push("json_extract(value, '$.name') IN (SELECT value FROM json_each(?))");
      parameters.push(JSON.stringify(names));
    }
    const projection = predicates.length === 0 ? 'rows_json' : `(
      SELECT json_group_array(json(value)) FROM jsonb_each(aggregates.rows_json)
      WHERE ${predicates.join(' AND ')}
    ) AS rows_json`;
    const rows = this.database.prepare(`
      SELECT project, bucket_from, bucket_to, finalized, drop_count, ${projection}
      FROM ${table} AS aggregates
      WHERE project = ? AND bucket_from >= ? AND bucket_from < ? AND bucket_to > ?
      ORDER BY bucket_from LIMIT ?
    `).all(...parameters, project, Math.floor(from / WIDTH_BY_TIER[tier]) * WIDTH_BY_TIER[tier],
      to, from, this.settings.maxHistoryBuckets + 1);
    if (rows.length > this.settings.maxHistoryBuckets) throw new Error('history range exceeds configured bucket maximum');
    const buckets = [];
    let returnedRows = 0;
    for (const stored of rows) {
      const bucket = storedBucket(stored, tier);
      returnedRows += bucket.rows.length;
      if (returnedRows > limit) throw new Error('history result exceeds requested row limit');
      buckets.push(bucket);
    }
    return buckets;
  }

  replaceCompactedBucket({ sourceTier, destinationTier, bucket, sourceThrough, updatedAt = Date.now() }) {
    if (sourceTier !== 'minute' && sourceTier !== 'hour') throw new Error('sourceTier must be minute or hour');
    if (destinationTier !== 'hour' && destinationTier !== 'day') throw new Error('destinationTier must be hour or day');
    if ((sourceTier === 'minute' && destinationTier !== 'hour') || (sourceTier === 'hour' && destinationTier !== 'day')) {
      throw new Error('compaction tier pair must be minute-to-hour or hour-to-day');
    }
    validateBucket(bucket, destinationTier);
    return this._transaction(() => {
      this._assertHistoricalBucketMutable(destinationTier, bucket);
      const table = tableForTier(destinationTier);
      this.database.prepare(`
        INSERT INTO ${table}(project, bucket_from, bucket_to, finalized, drop_count, rows_json)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project, bucket_from) DO UPDATE SET bucket_to = excluded.bucket_to,
          finalized = excluded.finalized, drop_count = excluded.drop_count, rows_json = excluded.rows_json
      `).run(bucket.project, bucket.from, bucket.to, bucket.finalized ? 1 : 0, bucket.dropCount, JSON.stringify(bucket.rows));
      this.database.prepare(`
        INSERT INTO compaction_watermarks(project, source_tier, destination_tier, source_through, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project, source_tier, destination_tier) DO UPDATE SET
          source_through = MAX(source_through, excluded.source_through), updated_at = excluded.updated_at
      `).run(bucket.project, sourceTier, destinationTier, sourceThrough, updatedAt);
      return bucket;
    });
  }

  readWatermark(project, sourceTier, destinationTier) {
    const row = this.database.prepare(`
      SELECT source_through FROM compaction_watermarks
      WHERE project = ? AND source_tier = ? AND destination_tier = ?
    `).get(project, sourceTier, destinationTier);
    return row ? row.source_through : null;
  }

  checkpoint() {
    const started = process.hrtime.bigint();
    try {
      const rows = this.database.pragma(`wal_checkpoint(${this.settings.checkpointMode})`);
      this.metrics.checkpoints += 1;
      for (const row of rows) {
        this.metrics.checkpointBusy += row.busy || 0;
        this.metrics.checkpointLogFrames += row.log || 0;
        this.metrics.checkpointedFrames += row.checkpointed || 0;
      }
      return rows;
    } catch (error) {
      this.metrics.checkpointFailures += 1;
      throw error;
    } finally {
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      this.metrics.checkpointLatencyTotalMs += elapsedMs;
      this.metrics.checkpointLatencyMaxMs = Math.max(this.metrics.checkpointLatencyMaxMs, elapsedMs);
    }
  }

  optimize(onOpen = false) {
    const started = process.hrtime.bigint();
    try {
      this.database.pragma(onOpen ? 'optimize=0x10002' : 'optimize');
      this.metrics.optimizations += 1;
    } catch (error) {
      this.metrics.optimizationFailures += 1;
      throw error;
    } finally {
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      this.metrics.optimizationLatencyTotalMs += elapsedMs;
      this.metrics.optimizationLatencyMaxMs = Math.max(this.metrics.optimizationLatencyMaxMs, elapsedMs);
    }
  }

  snapshotMetrics() {
    const wal = this.database.open ? this.database.pragma('wal_checkpoint(NOOP)')[0] : null;
    return {
      ...this.metrics,
      wal: wal === null ? null : {
        busy: wal.busy,
        logFrames: wal.log,
        checkpointedFrames: wal.checkpointed,
        pendingFrames: wal.log < 0 || wal.checkpointed < 0 ? null : Math.max(0, wal.log - wal.checkpointed)
      },
      checkpointLatencyMs: {
        total: this.metrics.checkpointLatencyTotalMs,
        max: this.metrics.checkpointLatencyMaxMs
      },
      optimizationLatencyMs: {
        total: this.metrics.optimizationLatencyTotalMs,
        max: this.metrics.optimizationLatencyMaxMs
      },
      transactionLatencyMs: {
        total: this.metrics.transactionLatencyTotalMs,
        max: this.metrics.transactionLatencyMaxMs
      }
    };
  }

  tableNames() {
    return tableNames(this.database);
  }

  probeWritable(timeoutMs) {
    requirePositiveInteger(timeoutMs, 'SQLite probe timeout');
    if (!this.database.open) throw new Error('SQLite is closed');
    this.database.pragma(`busy_timeout = ${timeoutMs}`);
    try {
      this.database.transaction(() => {
        const update = this.database.prepare(
          'UPDATE schema_metadata SET version = ? WHERE singleton = 1 AND version = ?'
        );
        const changed = update.run(-SCHEMA_VERSION, SCHEMA_VERSION);
        if (changed.changes !== 1) throw new Error('SQLite schema metadata is invalid');
        const restored = update.run(SCHEMA_VERSION, -SCHEMA_VERSION);
        if (restored.changes !== 1) throw new Error('SQLite probe failed to restore schema metadata');
      }).immediate();
    } finally {
      this.database.pragma(`busy_timeout = ${this.settings.busyTimeoutMs}`);
    }
  }

  close({ checkpoint = true } = {}) {
    if (!this.database.open) return;
    if (checkpoint) this.checkpoint();
    this.database.close();
  }
}
