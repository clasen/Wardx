import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { listen } from '../src/server.js';
import { addCredential, initSite, mcpUrl, parseClientSpec, rotateMcpToken } from '../src/setup.js';
import { sampleEnvelope } from './helpers.js';

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'wardx-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function readSecrets(dir) {
  return JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8'));
}

test('init writes a private secrets file with prefixed keys and refuses a non-empty directory', (t) => {
  const dir = join(temporaryRoot(t), 'wardx.example.com');
  const secrets = initSite({
    dir,
    project: 'truco',
    clients: ['shot:trusted', 'app:public'].map(parseClientSpec)
  });
  assert.deepEqual(readSecrets(dir), secrets);
  assert.equal(statSync(join(dir, 'secrets.json')).mode & 0o777, 0o600);
  assert.match(secrets.mcpToken, /^wdx_mcp_[A-Za-z0-9_-]{43}$/);
  const byLabel = Object.fromEntries(Object.entries(secrets.credentials).map(([key, record]) => [record.label, { key, record }]));
  assert.match(byLabel['truco-shot'].key, /^wdx_srv_/);
  assert.equal(byLabel['truco-shot'].record.trustedForDecisions, true);
  assert.match(byLabel['truco-app'].key, /^wdx_pub_/);
  assert.deepEqual(byLabel['truco-app'].record.allowedRoles, ['app']);
  assert.equal(mcpUrl(dir), 'https://wardx.example.com/mcp');
  assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /^secrets\.json$/m);
  assert.throws(() => initSite({ dir, project: 'truco', clients: [parseClientSpec('a:public')] }), /not empty/);
  assert.throws(() => parseClientSpec('shot'), /role:trusted or role:public/);
  assert.throws(() => parseClientSpec('*:public'), /role:trusted or role:public/);
});

test('credential add and mcp-token rotation keep the other secrets', (t) => {
  const dir = join(temporaryRoot(t), 'site');
  const initial = initSite({ dir, project: 'truco', clients: [parseClientSpec('app:public')] });
  const { key, record } = addCredential({ dir, project: 'truco', role: 'backend', trusted: true });
  assert.equal(record.label, 'truco-backend');
  const added = readSecrets(dir);
  assert.deepEqual(added.credentials, { ...initial.credentials, [key]: record });
  assert.equal(added.mcpToken, initial.mcpToken);

  const token = rotateMcpToken({ dir });
  assert.notEqual(token, initial.mcpToken);
  assert.deepEqual(readSecrets(dir), { mcpToken: token, credentials: added.credentials });
  assert.equal(statSync(join(dir, 'secrets.json')).mode & 0o777, 0o600);
  assert.throws(() => rotateMcpToken({ dir: join(dir, 'missing') }), /run wardx-server init first/);
});

test('the generated site serves ingest and MCP through a virtual server close hook', async (t) => {
  const root = temporaryRoot(t);
  mkdirSync(join(root, 'node_modules', '@wardx'), { recursive: true });
  symlinkSync(PACKAGE_DIR, join(root, 'node_modules', '@wardx', 'server'), 'dir');
  const dir = join(root, 'wardx.example.com');
  const secrets = initSite({ dir, project: 'demo', clients: [parseClientSpec('client:public')] });
  const [projectKey] = Object.keys(secrets.credentials);

  const site = await import(pathToFileURL(join(dir, 'index.js')).href);
  const closeHooks = [];
  const handler = site.default({ onClose: (hook) => closeHooks.push(hook) });
  t.after(() => site.stop());
  const external = http.createServer(handler);
  const address = await listen(external, 0, '127.0.0.1');
  t.after(() => new Promise((resolve) => external.close(resolve)));
  const base = `http://127.0.0.1:${address.port}`;

  const sync = await fetch(`${base}/v1/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wardx-key': projectKey },
    body: JSON.stringify(sampleEnvelope())
  });
  assert.equal(sync.status, 200);

  const client = new Client({ name: 'setup-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${secrets.mcpToken}` } }
  }));
  const result = await client.callTool({ name: 'list_projects', arguments: {} });
  assert.deepEqual(JSON.parse(result.content[0].text), { projects: ['demo'] });
  await client.close();

  assert.equal(closeHooks.length, 1);
  await closeHooks[0]();
  assert.equal((await fetch(`${base}/ready`)).status, 503);
});
