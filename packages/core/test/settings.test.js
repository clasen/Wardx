import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveSettings } from '../src/settings.js';

test('createWardx settings crash when required keys are missing', () => {
  assert.throws(() => resolveSettings({}), /missing required keys/);
});

test('createWardx settings crash when histogram buckets are not increasing', () => {
  assert.throws(
    () =>
      resolveSettings({
        endpoint: 'http://127.0.0.1:1',
        projectKey: 'k',
        project: 'p',
        appVersion: '1',
        environment: 'test',
        histogramBuckets: [10, 10]
      }),
    /histogramBuckets/
  );
});
