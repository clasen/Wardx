import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveSettings } from '../src/settings.js';

test('createWardx settings crash when required keys are missing', () => {
  assert.throws(() => resolveSettings({}), /missing required keys/);
});

test('createWardx settings crash when role is empty or *', () => {
  const base = {
    endpoint: 'http://127.0.0.1:1',
    projectKey: 'k',
    project: 'p',
    appVersion: '1',
    environment: 'test',
    privacySalt: 'test-salt'
  };
  assert.throws(() => resolveSettings({ ...base, role: '' }), /role must be a non-empty string/);
  assert.throws(() => resolveSettings({ ...base, role: '*' }), /role cannot be \*/);
});

test('createWardx settings crash when histogram buckets are not increasing', () => {
  assert.throws(
    () =>
      resolveSettings({
        endpoint: 'http://127.0.0.1:1',
        projectKey: 'k',
        project: 'p',
        role: 'unity',
        appVersion: '1',
        environment: 'test',
        privacySalt: 'test-salt',
        histogramBuckets: [10, 10]
      }),
    /histogramBuckets/
  );
});

test('createWardx settings crash when tracer is not an object', () => {
  const base = {
    endpoint: 'http://127.0.0.1:1',
    projectKey: 'k',
    project: 'p',
    role: 'client',
    appVersion: '1',
    environment: 'test',
    privacySalt: 'test-salt'
  };
  assert.throws(() => resolveSettings({ ...base, tracer: 'console' }), /tracer must be an object/);
  assert.throws(() => resolveSettings({ ...base, tracer: [] }), /tracer must be an object/);
  const settings = resolveSettings({ ...base, tracer: { measure() {} } });
  assert.equal(typeof settings.tracer.measure, 'function');
});

test('createWardx requires an explicit privacy salt and a 1KB frame minimum', () => {
  const base = {
    endpoint: 'http://127.0.0.1:1',
    projectKey: 'k',
    project: 'p',
    role: 'client',
    appVersion: '1',
    environment: 'test',
    privacySalt: 'test-salt'
  };
  const { privacySalt: _removed, ...withoutSalt } = base;
  assert.throws(() => resolveSettings(withoutSalt), /privacySalt/);
  assert.throws(() => resolveSettings({ ...base, maxFrameBytes: 1023 }), /at least 1024/);
  for (const maxPendingFrames of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => resolveSettings({ ...base, maxPendingFrames }), /maxPendingFrames/);
  }
  assert.throws(
    () => resolveSettings({ ...base, experimentStateMaxSubjects: 1.5 }),
    /experimentStateMaxSubjects must be an integer/
  );
});
