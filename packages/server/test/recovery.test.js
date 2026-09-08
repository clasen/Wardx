import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { backup, resetData, restore, verify } from '../src/ops/recovery.js';
import { loadServerConfig } from '../src/loadConfig.js';
import { createIngestServer, listen } from '../src/server.js';
import { testServerConfig } from './helpers.js';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'wardx-recovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = testServerConfig();
  config.sqlite.path = './live.sqlite';
  const configPath = join(directory, 'live.json');
  writeFileSync(configPath, JSON.stringify(config));
  const server = createIngestServer(loadServerConfig(configPath));
  t.after(() => server.wardx.stop());
  return { directory, configPath, server, backupPath: join(directory, 'backup') };
}

function rehash(directory, name) {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json')));
  manifest.files[name] = createHash('sha256').update(readFileSync(join(directory, name))).digest('hex');
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
}

test('backup and restore recover authoritative config, history, experiments and journal into an independent running server', async (t) => {
  const { directory, configPath, server, backupPath } = await fixture(t);
  const control = server.wardx.control;
  control.setValue('demo', 'message.delayMs', 250, ['client'], { expectedVersion: 12, reason: 'recovery test' });
  const experiment = {
    id: 'delay', enabled: true, allocation: 1, salt: 'recovery-test',
    primaryMetric: 'message.sent', goalMetric: 'message.sent', assignmentUnitKind: 'subject',
    terminalRetentionMs: 604800000, roles: ['client'],
    variants: [
      { key: 'control', weight: 50, values: { 'message.delayMs': 1000 } },
      { key: 'fast', weight: 50, values: { 'message.delayMs': 400 } }
    ]
  };
  control.upsertExperiment('demo', experiment, { expectedVersion: 13, reason: 'recovery test' });
  const from = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const bucket = {
    project: 'demo', tier: 'hour', from, to: from + 3_600_000, finalized: false, dropCount: 0,
    rows: [{ kind: 'counter', name: 'requests', role: 'client', environment: 'test', appVersion: '1', dimensions: null, value: 42 }]
  };
  server.wardx.stateStore.saveBuckets('hour', [bucket]);
  const event = { experiment: 'delay', variant: 'fast', assignmentHash: 'ab'.repeat(8), timestamp: Date.now() };
  server.wardx.experimentLedger.ingestBatch('demo', [
    { ...event, kind: 'exposure' }, { ...event, kind: 'goal', value: 1 }
  ], { role: 'client', trustedForDecisions: true });
  const decision = { status: 'winner', method: 'test', terminalInput: { analysisAt: Date.now() }, winner: 'fast' };
  server.wardx.experimentLedger.persistTerminalDecision('demo', 'delay', decision);
  const expectedTotals = server.wardx.experimentLedger.totals('demo', 'delay');
  await server.wardx.stop();
  const originalConfig = readFileSync(configPath);
  assert.deepEqual(await backup(configPath, backupPath), { ok: true, projects: 1 });
  assert.deepEqual(readFileSync(configPath), originalConfig);
  const originalBackupFiles = readdirSync(backupPath);
  assert.deepEqual(await verify(backupPath), { ok: true, projects: 1 });
  assert.deepEqual(readdirSync(backupPath), originalBackupFiles);
  const destination = join(directory, 'restored');
  const result = await restore(backupPath, destination);
  assert.equal(result.configPath, join(destination, 'config.json'));
  const restarted = createIngestServer(loadServerConfig(result.configPath));
  t.after(() => restarted.wardx.stop());
  const address = await listen(restarted, 0, '127.0.0.1');
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(response.status, 200);
  assert.equal(restarted.wardx.control.getConfig('demo').values['message.delayMs'], 250);
  assert.equal(restarted.wardx.control.getConfig('demo').version, 14);
  assert.equal(restarted.wardx.control.getConfig('demo').experiments[0].id, 'delay');
  assert.deepEqual(restarted.wardx.stateStore.readBucket('demo', 'hour', from), bucket);
  assert.equal(restarted.wardx.stateStore.listJournal('demo', { limit: 10 }).length, 2);
  assert.deepEqual(restarted.wardx.experimentLedger.totals('demo', 'delay'), expectedTotals);
  assert.deepEqual(restarted.wardx.experimentLedger.readTerminalDecision('demo', 'delay'), decision);
  assert.equal(restarted.wardx.stateStore.database.prepare('SELECT count(*) AS n FROM experiment_assignment_ledger').get().n, 1);
  await restarted.wardx.stop();
  assert.deepEqual(await verify(backupPath), { ok: true, projects: 1 });
  if (process.platform !== 'win32') {
    assert.equal(statSync(backupPath).mode & 0o777, 0o700);
    for (const name of originalBackupFiles) assert.equal(statSync(join(backupPath, name)).mode & 0o777, 0o600);
  }
});

test('SQLite backup includes committed WAL data without mutating the source config', async (t) => {
  const { configPath, server, backupPath } = await fixture(t);
  server.wardx.control.setValue('demo', 'message.delayMs', 345, ['client'], { expectedVersion: 12, reason: 'WAL test' });
  await backup(configPath, backupPath);
  const database = new Database(join(backupPath, 'state.sqlite'), { readonly: true });
  try {
    assert.equal(JSON.parse(database.prepare('SELECT state_json FROM project_state').get().state_json).values['message.delayMs'], 345);
  } finally {
    database.close();
  }
});

test('recovery never overwrites existing directories or follows file symlinks', async (t) => {
  const { directory, configPath, server, backupPath } = await fixture(t);
  await server.wardx.stop();
  await backup(configPath, backupPath);
  const original = readFileSync(join(backupPath, 'state.sqlite'));
  await assert.rejects(backup(configPath, backupPath), /Backup failed/);
  await assert.rejects(restore(backupPath, directory), /Restore failed/);
  assert.deepEqual(readFileSync(join(backupPath, 'state.sqlite')), original);
  const symlinkPath = join(directory, 'linked');
  symlinkSync(backupPath, symlinkPath, 'dir');
  await assert.rejects(verify(symlinkPath), /verification failed/);
  rmSync(join(backupPath, 'config.json'));
  symlinkSync(configPath, join(backupPath, 'config.json'));
  await assert.rejects(verify(backupPath), /verification failed/);
});

test('verify rejects tampering, incompatible schemas and invalid durable state even with matching hashes', async (t) => {
  const { configPath, server, backupPath } = await fixture(t);
  await server.wardx.stop();
  await backup(configPath, backupPath);
  const configFile = join(backupPath, 'config.json');
  const originalConfig = readFileSync(configFile);
  writeFileSync(configFile, `${originalConfig}\n`);
  await assert.rejects(verify(backupPath), /verification failed/);
  writeFileSync(configFile, originalConfig);
  const originalDb = readFileSync(join(backupPath, 'state.sqlite'));
  let database = new Database(join(backupPath, 'state.sqlite'));
  database.pragma('user_version = 99');
  database.close();
  rehash(backupPath, 'state.sqlite');
  await assert.rejects(verify(backupPath), /verification failed/);
  writeFileSync(join(backupPath, 'state.sqlite'), originalDb);
  database = new Database(join(backupPath, 'state.sqlite'));
  database.prepare('UPDATE project_state SET state_json = ?').run(JSON.stringify({ values: {}, keyRoles: {}, experiments: 'invalid' }));
  database.close();
  rehash(backupPath, 'state.sqlite');
  await assert.rejects(verify(backupPath), /verification failed/);
  writeFileSync(join(backupPath, 'state.sqlite'), originalDb);
  database = new Database(join(backupPath, 'state.sqlite'));
  database.prepare('INSERT INTO hour_aggregates VALUES (?, ?, ?, ?, ?, ?)').run('demo', 0, 3_600_000, 1, 0, '{"not":"rows"}');
  database.close();
  rehash(backupPath, 'state.sqlite');
  await assert.rejects(verify(backupPath), /verification failed/);
  writeFileSync(join(backupPath, 'state.sqlite'), 'not a SQLite database');
  rehash(backupPath, 'state.sqlite');
  await assert.rejects(verify(backupPath), /verification failed/);
});

test('restore redirects NDJSON output into the new directory and CLI reports no configuration contents', async (t) => {
  const { directory, configPath, server, backupPath } = await fixture(t);
  await server.wardx.stop();
  const config = JSON.parse(readFileSync(configPath));
  config.sink = 'ndjson';
  config.ndjsonPath = join(directory, 'original-events.ndjson');
  writeFileSync(configPath, JSON.stringify(config));
  await backup(configPath, backupPath);
  const result = await restore(backupPath, join(directory, 'restored'));
  const restoredConfig = loadServerConfig(result.configPath);
  assert.equal(restoredConfig.ndjsonPath, join(directory, 'restored', 'events.ndjson'));
  const restarted = createIngestServer(restoredConfig);
  restarted.wardx.sink.ingest({ test: 'restored' });
  await restarted.wardx.stop();
  assert.equal(readFileSync(restoredConfig.ndjsonPath, 'utf8').trim(), '{"test":"restored"}');
  const output = execFileSync(process.execPath, [resolve('packages/server/src/ops/recovery-cli.js'), 'verify', backupPath], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), { ok: true, projects: 1 });
  writeFileSync(join(backupPath, 'config.json'), '{"credential-should-never-appear"');
  try {
    execFileSync(process.execPath, [resolve('packages/server/src/ops/recovery-cli.js'), 'verify', backupPath], { encoding: 'utf8', stdio: 'pipe' });
    assert.fail('CLI must reject invalid backup');
  } catch (error) {
    assert.equal(error.status, 1);
    assert.doesNotMatch(error.stderr, /credential-should-never-appear/);
  }
});

for (const version of [1, 2, 3]) {
  test(`reset-data clears telemetry from schema ${version} and preserves descriptions and configuration`, async (t) => {
    const { directory, configPath, server } = await fixture(t);
    server.wardx.control.setSignal('demo', 'message.sent', { description: 'Messages sent by players' }, {
      expectedVersion: 12, reason: 'keep descriptions'
    });
    server.wardx.control.setValue('demo', 'message.delayMs', 250, ['client'], {
      expectedVersion: 13, reason: 'keep Remote Config'
    });
    const database = server.wardx.stateStore.database;
    const projects = database.prepare('SELECT * FROM project_state ORDER BY project').all();
    const journal = database.prepare('SELECT * FROM mutation_journal ORDER BY id').all();
    await server.wardx.stop();
    const source = new Database(join(directory, 'live.sqlite'));
    for (const table of ['minute_aggregates', 'hour_aggregates', 'day_aggregates']) {
      source.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?, ?, ?)`)
        .run('demo', 0, 60000, 0, 0, '[]');
    }
    source.exec("INSERT INTO compaction_watermarks VALUES ('demo', 'minute', 'hour', 0, 0)");
    source.exec("INSERT INTO experiment_totals VALUES ('demo', 'exp', 'control', 'client', 'trusted', '{}')");
    source.exec("INSERT INTO experiment_terminal_decisions VALUES ('demo', 'exp', 0, '{}')");
    for (const [table, column] of [['experiment_assignment_ledger', 'assignment_hash'], ['retention_users', 'subject_hash']]) {
      if (version < 3) {
        const sql = source.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(table).sql;
        source.exec(`DROP TABLE ${table}`);
        source.exec(sql.replace(`length(${column}) = 8`, `length(${column}) = 32`));
      }
    }
    source.prepare('INSERT INTO experiment_assignment_ledger VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('demo', 'exp', Buffer.alloc(version < 3 ? 32 : 8, 1), 'control', '{}', null, 'client', 'trusted', 1000);
    if (version === 1) {
      source.exec('DROP TABLE retention_users; DROP TABLE retention_projects');
    } else {
      source.prepare('INSERT INTO retention_projects VALUES (?, ?, ?)').run('demo', 'old-salt', 1);
      source.prepare('INSERT INTO retention_users VALUES (?, ?, ?, ?)')
        .run('demo', Buffer.alloc(version < 3 ? 32 : 8, 2), 0, 1);
    }
    source.exec(`UPDATE schema_metadata SET version = ${version}; PRAGMA user_version = ${version}`);
    source.close();
    const originalConfig = readFileSync(configPath);
    const result = JSON.parse(execFileSync(process.execPath, [
      resolve('packages/server/src/ops/recovery-cli.js'), 'reset-data', join(directory, 'live.sqlite')
    ], { encoding: 'utf8' }));
    assert.equal(result.ok, true);
    assert.equal(result.schemaVersion, 3);
    assert.equal(result.removedRows, version === 1 ? 7 : 9);
    assert.deepEqual(readFileSync(configPath), originalConfig);
    const restarted = createIngestServer(loadServerConfig(configPath));
    try {
      const fresh = restarted.wardx.stateStore.database;
      assert.deepEqual(fresh.prepare('SELECT * FROM project_state ORDER BY project').all(), projects);
      assert.deepEqual(fresh.prepare('SELECT * FROM mutation_journal ORDER BY id').all(), journal);
      for (const { name } of fresh.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
        if (['project_state', 'mutation_journal', 'schema_metadata'].includes(name)) continue;
        assert.equal(fresh.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get().count, 0, name);
      }
      restarted.wardx.retentionLedger.ingestBatch('demo', [{ timestamp: 0, subject: 'ab'.repeat(8), salt: 'cd'.repeat(8) }]);
    } finally {
      await restarted.wardx.stop();
    }
    assert.equal((await resetData(join(directory, 'live.sqlite'))).removedRows, 2);
    assert.equal((await resetData(join(directory, 'live.sqlite'))).removedRows, 0);
  });
}

test('reset-data rejects unknown schemas without clearing data', async (t) => {
  const { directory, server } = await fixture(t);
  await server.wardx.stop();
  const source = new Database(join(directory, 'live.sqlite'));
  source.pragma('user_version = 99');
  const before = source.prepare('SELECT * FROM project_state').all();
  source.close();
  await assert.rejects(resetData(join(directory, 'live.sqlite')), /unsupported SQLite schema/);
  const after = new Database(join(directory, 'live.sqlite'));
  try {
    assert.equal(after.pragma('user_version', { simple: true }), 99);
    assert.deepEqual(after.prepare('SELECT * FROM project_state').all(), before);
  } finally {
    after.close();
  }
});

test('reset-data rolls back all deletions when schema recreation fails', async (t) => {
  const { directory, server } = await fixture(t);
  await server.wardx.stop();
  const source = new Database(join(directory, 'live.sqlite'));
  source.exec("INSERT INTO minute_aggregates VALUES ('demo', 0, 60000, 0, 0, '[]')");
  source.exec('DROP INDEX retention_cohorts; CREATE INDEX retention_cohorts ON project_state(project)');
  const before = source.prepare('SELECT * FROM minute_aggregates').all();
  source.close();
  await assert.rejects(resetData(join(directory, 'live.sqlite')), /already exists/);
  const after = new Database(join(directory, 'live.sqlite'));
  try {
    assert.deepEqual(after.prepare('SELECT * FROM minute_aggregates').all(), before);
    assert.equal(after.pragma('user_version', { simple: true }), 3);
    assert.equal(after.prepare("SELECT tbl_name FROM sqlite_master WHERE name = 'retention_cohorts'").get().tbl_name, 'project_state');
  } finally {
    after.close();
  }
});

test('reset-data refuses a missing database and a database with an active writer', async (t) => {
  const { directory, configPath, server } = await fixture(t);
  await server.wardx.stop();
  const missing = join(directory, 'missing.sqlite');
  await assert.rejects(resetData(missing), /ENOENT/);
  assert.equal(readdirSync(directory).includes('missing.sqlite'), false);
  const path = join(directory, 'live.sqlite');
  const source = new Database(path);
  source.exec('BEGIN IMMEDIATE');
  try {
    await assert.rejects(resetData(path), /locked/);
  } finally {
    source.exec('ROLLBACK');
    source.close();
  }
  assert.equal(loadServerConfig(configPath).sqlite.path, './live.sqlite');
});

for (const version of [1, 2, 3]) {
  test(`hash-data-only preserves numeric history and watermarks from schema ${version}`, async (t) => {
    const { directory, server } = await fixture(t);
    await server.wardx.stop();
    const path = join(directory, 'live.sqlite');
    const db = new Database(path);
    const projects = db.prepare('SELECT * FROM project_state').all();
    const numeric = [
      { kind: 'gauge', name: 'cpu', lastValue: 25, min: 10, max: 30, sampleCount: 5, lastTimestamp: 1000 },
      { kind: 'counter', name: 'requests', value: 123 },
      { kind: 'histogram', name: 'latency', count: 2, sum: 12, min: 5, max: 7, buckets: [[10, 2]] }
    ];
    const distinct = { kind: 'distinct', name: 'users', precision: 9, registers: Buffer.alloc(512).toString('base64') };
    for (const table of ['minute_aggregates', 'hour_aggregates', 'day_aggregates']) {
      const insert = db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?, ?, ?)`);
      insert.run('demo', 0, 60000, 1, 3, JSON.stringify([...numeric, distinct]));
      insert.run('demo', 60000, 120000, 0, 0, JSON.stringify([distinct]));
      insert.run('other', 0, 60000, 0, 0, JSON.stringify(numeric));
    }
    db.exec("INSERT INTO compaction_watermarks VALUES ('demo', 'minute', 'hour', 60000, 1000)");
    const watermarks = db.prepare('SELECT * FROM compaction_watermarks').all();
    db.exec("INSERT INTO experiment_totals VALUES ('demo', 'exp', 'control', 'client', 'trusted', '{}')");
    db.exec("INSERT INTO experiment_terminal_decisions VALUES ('demo', 'exp', 0, '{}')");
    if (version === 1) db.exec('DROP TABLE retention_users; DROP TABLE retention_projects');
    else {
      db.exec("INSERT INTO retention_projects VALUES ('demo', 'old-salt', 1)");
      db.prepare('INSERT INTO retention_users VALUES (?, ?, ?, ?)').run('demo', Buffer.alloc(8), 0, 1);
    }
    db.exec(`UPDATE schema_metadata SET version = ${version}; PRAGMA user_version = ${version}`);
    db.close();
    const output = JSON.parse(execFileSync(process.execPath, [
      resolve('packages/server/src/ops/recovery-cli.js'), 'reset-data', path, '--hash-data-only'
    ], { encoding: 'utf8' }));
    assert.equal(output.removedDistincts, 6);
    assert.equal(output.removedRows, version === 1 ? 2 : 4);
    const fresh = new Database(path);
    try {
      assert.deepEqual(fresh.prepare('SELECT * FROM project_state').all(), projects);
      assert.deepEqual(fresh.prepare('SELECT * FROM compaction_watermarks').all(), watermarks);
      for (const table of ['minute_aggregates', 'hour_aggregates', 'day_aggregates']) {
        const buckets = fresh.prepare(`SELECT * FROM ${table} ORDER BY project, bucket_from`).all();
        assert.equal(buckets.length, 3);
        assert.deepEqual(JSON.parse(buckets[0].rows_json), numeric);
        assert.equal(buckets[0].finalized, 1);
        assert.equal(buckets[0].drop_count, 3);
        assert.equal(buckets[0].bucket_to, 60000);
        assert.deepEqual(JSON.parse(buckets[1].rows_json), []);
        assert.deepEqual(JSON.parse(buckets[2].rows_json), numeric);
      }
      for (const table of ['retention_users', 'retention_projects', 'experiment_assignment_ledger', 'experiment_totals', 'experiment_terminal_decisions']) {
        assert.equal(fresh.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
      }
      assert.equal(fresh.pragma('user_version', { simple: true }), 3);
    } finally { fresh.close(); }
    assert.deepEqual(await resetData(path, { hashDataOnly: true }), { ok: true, removedRows: 0, removedDistincts: 0, schemaVersion: 3 });
  });
}

test('hash-data-only rolls back filtered history on failure and rejects unknown CLI flags', async (t) => {
  const { directory, server } = await fixture(t);
  await server.wardx.stop();
  const path = join(directory, 'live.sqlite');
  const db = new Database(path);
  db.prepare('INSERT INTO minute_aggregates VALUES (?, ?, ?, ?, ?, ?)')
    .run('demo', 0, 60000, 0, 0, JSON.stringify([{ kind: 'distinct' }]));
  db.exec("INSERT INTO hour_aggregates VALUES ('demo', 0, 3600000, 0, 0, 'invalid-json')");
  const before = db.prepare('SELECT * FROM minute_aggregates').all();
  db.close();
  assert.throws(() => execFileSync(process.execPath, [
    resolve('packages/server/src/ops/recovery-cli.js'), 'reset-data', path, '--hash-only-typo'
  ], { stdio: 'pipe' }), /Command failed/);
  await assert.rejects(resetData(path, { hashDataOnly: true }), SyntaxError);
  const after = new Database(path);
  try { assert.deepEqual(after.prepare('SELECT * FROM minute_aggregates').all(), before); }
  finally { after.close(); }
});
