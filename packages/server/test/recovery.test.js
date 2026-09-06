import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { backup, restore, verify } from '../src/ops/recovery.js';
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
  const event = { experiment: 'delay', variant: 'fast', assignmentHash: 'ab'.repeat(32), timestamp: Date.now() };
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
