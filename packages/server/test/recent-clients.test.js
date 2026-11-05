import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecentClients } from '../src/clients/RecentClients.js';

const sdk = { name: 'wardx-unity', version: '0.11.0' };

function client(instanceId, role) {
  return { instanceId, role, appVersion: '1.0.0', environment: 'production', platform: 'unity', os: 'android' };
}

test('RecentClients keeps the reporting SDK name and version', () => {
  const clients = new RecentClients(10);
  clients.touch(client('a', 'app'), sdk);
  const [row] = clients.list();
  assert.equal(row.sdkName, 'wardx-unity');
  assert.equal(row.sdkVersion, '0.11.0');
});

test('RecentClients caps each role separately so a large role cannot evict a small one', () => {
  const clients = new RecentClients(2);
  clients.touch(client('server-1', 'backend'), sdk);
  for (const id of ['a', 'b', 'c', 'd']) clients.touch(client(id, 'app'), sdk);
  const rows = clients.list();
  assert.deepEqual(rows.filter((row) => row.role === 'app').map((row) => row.instanceId).sort(), ['c', 'd']);
  assert.deepEqual(rows.filter((row) => row.role === 'backend').map((row) => row.instanceId), ['server-1']);
});

test('RecentClients lists an instance once after it changes role', () => {
  const clients = new RecentClients(2);
  clients.touch(client('a', 'app'), sdk);
  clients.touch(client('a', 'backend'), sdk);
  assert.deepEqual(clients.list().map((row) => [row.instanceId, row.role]), [['a', 'backend']]);
});
