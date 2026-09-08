import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { loadServerConfig, validateServerConfig } from '../loadConfig.js';
import { SqliteStateStore, validateSqliteSchema } from '../storage/SqliteStateStore.js';
import { normalizeHistoryBucket } from '../aggregation/history/HistoryBucket.js';

const FILES = ['config.json', 'state.sqlite'];

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function requireFile(path) {
  if (!(await lstat(path)).isFile()) throw new Error('recovery requires regular files');
}

async function createDestination(path) {
  await mkdir(path, { mode: 0o700 });
}

function validateDatabase(database, config) {
  validateSqliteSchema(database);
  const integrity = database.pragma('integrity_check');
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
    throw new Error('SQLite integrity check failed');
  }
  const effective = structuredClone(config);
  const rows = database.prepare('SELECT project, version, state_json, catalog_json FROM project_state').all();
  const storedProjects = new Set(rows.map((row) => row.project));
  for (const project of Object.keys(config.projects)) {
    if (!storedProjects.has(project)) throw new Error('SQLite is missing a configured project');
  }
  for (const row of rows) {
    effective.projects[row.project] = {
      ...JSON.parse(row.state_json),
      version: row.version,
      catalog: JSON.parse(row.catalog_json)
    };
  }
  validateServerConfig(effective);
  for (const tier of ['minute', 'hour', 'day']) {
    for (const row of database.prepare(`SELECT * FROM ${tier}_aggregates`).iterate()) {
      normalizeHistoryBucket({
        project: row.project, tier, from: row.bucket_from, to: row.bucket_to,
        finalized: row.finalized === 1, dropCount: row.drop_count, rows: JSON.parse(row.rows_json)
      });
    }
  }
  for (const [table, columns] of [
    ['mutation_journal', ['entry_json']],
    ['experiment_assignment_ledger', ['exposure_json', 'goal_json']],
    ['experiment_totals', ['totals_json']],
    ['experiment_terminal_decisions', ['decision_json']]
  ]) {
    for (const column of columns) {
      if (database.prepare(`SELECT 1 FROM ${table} WHERE ${column} IS NOT NULL AND NOT json_valid(${column}) LIMIT 1`).get()) {
        throw new Error('SQLite contains invalid persisted JSON');
      }
    }
  }
  return { ok: true, projects: Object.keys(config.projects).length };
}

async function inspectBackup(directory) {
  if (!(await lstat(directory)).isDirectory()) throw new Error('backup must be a directory');
  for (const name of [...FILES, 'manifest.json']) await requireFile(join(directory, name));
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      await lstat(join(directory, `state.sqlite${suffix}`));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    throw new Error('backup must be a standalone SQLite snapshot');
  }
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  if (manifest.format !== 1 || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new Error('invalid backup manifest');
  }
  if (!manifest.files || JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify([...FILES].sort())) {
    throw new Error('invalid backup manifest files');
  }
  for (const name of FILES) {
    if (!/^[a-f0-9]{64}$/.test(manifest.files[name]) || await hashFile(join(directory, name)) !== manifest.files[name]) {
      throw new Error('backup checksum mismatch');
    }
  }
  const config = loadServerConfig(join(directory, 'config.json'));
  if (config.sqlite.path !== './state.sqlite' || (config.sink === 'ndjson' && !['./events.ndjson', resolve(directory, 'events.ndjson')].includes(config.ndjsonPath))) {
    throw new Error('backup configuration contains external storage paths');
  }
  const database = new Database(join(directory, 'state.sqlite'), { readonly: true, fileMustExist: true, timeout: config.sqlite.busyTimeoutMs });
  try {
    return { ...validateDatabase(database, config), config, files: manifest.files };
  } finally {
    database.close();
  }
}

export async function backup(configPath, destination) {
  try {
    const absoluteConfig = resolve(configPath);
    await requireFile(absoluteConfig);
    const config = loadServerConfig(absoluteConfig);
    const source = resolve(dirname(absoluteConfig), config.sqlite.path);
    await requireFile(source);
    const database = new Database(source, { readonly: true, fileMustExist: true, timeout: config.sqlite.busyTimeoutMs });
    try {
      await createDestination(destination);
      await database.backup(join(destination, 'state.sqlite'));
    } finally {
      database.close();
    }
    await chmod(join(destination, 'state.sqlite'), 0o600);
    const snapshot = new Database(join(destination, 'state.sqlite'), { fileMustExist: true, timeout: config.sqlite.busyTimeoutMs });
    try {
      snapshot.pragma('journal_mode = DELETE');
      validateDatabase(snapshot, config);
    } finally {
      snapshot.close();
    }
    const currentConfig = loadServerConfig(absoluteConfig);
    if (JSON.stringify(config) !== JSON.stringify(currentConfig)) throw new Error('configuration changed during backup');
    delete config.configPath;
    config.sqlite.path = './state.sqlite';
    if (config.sink === 'ndjson') config.ndjsonPath = './events.ndjson';
    await writeFile(join(destination, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const files = {};
    for (const name of FILES) files[name] = await hashFile(join(destination, name));
    await writeFile(join(destination, 'manifest.json'), `${JSON.stringify({ format: 1, createdAt: new Date().toISOString(), files }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return await verify(destination);
  } catch {
    throw new Error('Backup failed: check source configuration/database and use a new destination directory; incomplete output is retained.');
  }
}

export async function verify(directory) {
  try {
    const { config: _config, files: _files, ...result } = await inspectBackup(directory);
    return result;
  } catch {
    throw new Error('Backup verification failed: check manifest, checksums, SQLite integrity and configuration compatibility.');
  }
}

export async function restore(directory, destination) {
  try {
    const inspected = await inspectBackup(directory);
    await createDestination(destination);
    for (const name of [...FILES, 'manifest.json']) {
      await copyFile(join(directory, name), join(destination, name), constants.COPYFILE_EXCL);
      await chmod(join(destination, name), 0o600);
    }
    for (const name of FILES) {
      if (await hashFile(join(destination, name)) !== inspected.files[name]) throw new Error('backup changed during restore');
    }
    const config = loadServerConfig(join(destination, 'config.json'));
    if (config.sink === 'ndjson') {
      config.ndjsonPath = resolve(destination, 'events.ndjson');
      delete config.configPath;
      await writeFile(join(destination, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
      const manifest = JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8'));
      manifest.files['config.json'] = await hashFile(join(destination, 'config.json'));
      await writeFile(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    }
    const result = await verify(destination);
    return { ...result, configPath: resolve(destination, 'config.json') };
  } catch {
    throw new Error('Restore failed: verify the backup and use a new destination directory; incomplete output is retained.');
  }
}

export async function resetData(sqlitePath, { hashDataOnly = false } = {}) {
  if (typeof hashDataOnly !== 'boolean') throw new Error('hashDataOnly must be a boolean');
  const source = resolve(sqlitePath);
  await requireFile(source);
  const template = new Database(':memory:');
  let database;
  try {
    SqliteStateStore.initializeSchema(template);
    const preserved = new Set(['schema_metadata', 'project_state', 'mutation_journal']);
    const historyTables = ['minute_aggregates', 'hour_aggregates', 'day_aggregates'];
    if (hashDataOnly) {
      for (const table of [...historyTables, 'compaction_watermarks']) preserved.add(table);
    }
    const schema = template.prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END"
    ).all().filter((row) => !preserved.has(row.tbl_name));
    database = new Database(source, { fileMustExist: true, timeout: 0 });
    return database.transaction(() => {
      const version = database.pragma('user_version', { simple: true });
      if (![1, 2, SqliteStateStore.SCHEMA_VERSION].includes(version)) {
        throw new Error(`unsupported SQLite schema version ${version}`);
      }
      validateSqliteSchema(database, version);
      const integrity = database.pragma('integrity_check');
      if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
        throw new Error('SQLite integrity check failed');
      }
      let removedDistincts = 0;
      if (hashDataOnly) {
        for (const table of historyTables) {
          const update = database.prepare(`UPDATE ${table} SET rows_json = ? WHERE project = ? AND bucket_from = ?`);
          const select = `SELECT rowid AS id, project, bucket_from, rows_json FROM ${table}`;
          const first = database.prepare(`${select} ORDER BY rowid LIMIT 1`).safeIntegers();
          const next = database.prepare(`${select} WHERE rowid > ? ORDER BY rowid LIMIT 1`).safeIntegers();
          for (let bucket = first.get(); bucket; bucket = next.get(bucket.id)) {
            const rows = JSON.parse(bucket.rows_json);
            if (!Array.isArray(rows) || rows.some((row) => !row || typeof row.kind !== 'string')) {
              throw new Error('invalid historical rows');
            }
            const retained = rows.filter((row) => row.kind !== 'distinct');
            if (retained.length === rows.length) continue;
            removedDistincts += rows.length - retained.length;
            update.run(JSON.stringify(retained), bucket.project, bucket.bucket_from);
          }
        }
      }
      const tables = schema.filter((row) => row.type === 'table');
      let removedRows = 0;
      for (const { name } of tables) {
        if (version === 1 && name.startsWith('retention_')) continue;
        removedRows += database.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get().count;
        database.exec(`DROP TABLE "${name}"`);
      }
      for (const { sql } of schema) database.exec(sql);
      database.prepare('UPDATE schema_metadata SET version = ? WHERE singleton = 1').run(SqliteStateStore.SCHEMA_VERSION);
      database.pragma(`user_version = ${SqliteStateStore.SCHEMA_VERSION}`);
      validateSqliteSchema(database);
      return { ok: true, removedRows, ...(hashDataOnly ? { removedDistincts } : {}), schemaVersion: SqliteStateStore.SCHEMA_VERSION };
    }).immediate();
  } finally {
    if (database) database.close();
    template.close();
  }
}
