import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDiagnostics } from '../src/diagnostics.js';
import { testServerConfig } from './helpers.js';

test('diagnostics writes structured actionable fields without request secrets', () => {
  const lines = [];
  const diagnostics = createDiagnostics(testServerConfig({ diagnostics: { sink: 'stderr' } }), (line) => lines.push(line));
  const error = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  diagnostics.report('persistence.flush_failed', error, { project: 'demo' });

  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.type, 'persistence.flush_failed');
  assert.equal(record.error.name, 'Error');
  assert.equal(record.error.message, 'disk full');
  assert.equal(record.error.code, 'ENOSPC');
  assert.equal(record.project, 'demo');
  assert.deepEqual(Object.keys(record).sort(), ['error', 'project', 'ts', 'type']);
});

test('diagnostic writer failure never escapes to the caller', () => {
  const diagnostics = createDiagnostics(testServerConfig({ diagnostics: { sink: 'stderr' } }), () => {
    throw new Error('diagnostic sink failed');
  });
  assert.doesNotThrow(() => diagnostics.report('http.unexpected', new Error('handler failed')));
});
