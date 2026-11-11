import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SQLITE_BUSY = 5;
let savepointId = 0;

export function openDatabase(path, { readOnly = false, timeoutMs } = {}) {
  const options = { readOnly };
  if (timeoutMs !== undefined) options.timeout = timeoutMs;
  return new DatabaseSync(path, options);
}

export function pragmaValue(database, pragma) {
  const row = database.prepare(`PRAGMA ${pragma}`).get();
  return row === undefined ? undefined : Object.values(row)[0];
}

export function pragmaRows(database, pragma) {
  return database.prepare(`PRAGMA ${pragma}`).all();
}

// Bun's bundled SQLite omits the jsonb_each table function; json_each returns
// the same rows but re-parses each value, so it is used only where needed.
export function jsonEachFunction(database) {
  try {
    database.prepare("SELECT 1 FROM jsonb_each('[]')").all();
    return 'jsonb_each';
  } catch (error) {
    if (!/no such table: jsonb_each/.test(error.message)) throw error;
    return 'json_each';
  }
}

let noopCheckpointSupported;

// Builds without the NOOP checkpoint mode run it as PASSIVE, which checkpoints
// instead of sampling; probing a scratch database keeps real stores untouched.
export function supportsNoopCheckpoint() {
  if (noopCheckpointSupported !== undefined) return noopCheckpointSupported;
  const directory = mkdtempSync(join(tmpdir(), 'wardx-sqlite-probe-'));
  try {
    const database = new DatabaseSync(join(directory, 'probe.sqlite'));
    try {
      database.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE probe(value)');
      const [row] = database.prepare('PRAGMA wal_checkpoint(NOOP)').all();
      noopCheckpointSupported = row.log > 0 && row.checkpointed === 0;
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return noopCheckpointSupported;
}

export function isBusyError(error) {
  return (error?.errcode & 0xff) === SQLITE_BUSY;
}

// Outermost calls take the write lock up front with BEGIN IMMEDIATE; nested
// calls become savepoints so an inner failure rolls back only its own work.
export function immediateTransaction(database, work) {
  if (database.isTransaction) {
    const name = `wardx_${++savepointId}`;
    database.exec(`SAVEPOINT ${name}`);
    try {
      const result = work();
      database.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      database.exec(`ROLLBACK TO ${name}`);
      database.exec(`RELEASE ${name}`);
      throw error;
    }
  }
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  }
}
