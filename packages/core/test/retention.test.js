import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WardxCore } from '../src/WardxCore.js';
import { subjectHash } from '../src/config/hash.js';
import { testSettings } from './helpers.js';

test('retention requires an explicit user ID and emits stable hashes without the ID or salt', () => {
  const core = new WardxCore(testSettings());
  core.identify('implicit-user');
  for (const invalid of [undefined, null, '', '  ', 123]) {
    assert.throws(() => core.retentionActivity(invalid), /non-empty userId/);
  }
  core.retentionActivity('private-user');
  core.retentionActivity('private-user');
  const events = core.snapshotFrame().frames.flatMap((frame) => frame.events);
  assert.equal(events.length, 2);
  assert.equal(events[0][1], 'retention.activity');
  assert.deepEqual(events[0][2], {
    subject: subjectHash('test-salt', 'private-user'),
    salt: subjectHash('test-salt', 'wardx.retention.identity')
  });
  assert.deepEqual(events[1][2], events[0][2]);
  assert.equal(JSON.stringify(events).includes('private-user'), false);
  assert.equal(JSON.stringify(events).includes('test-salt'), false);
  assert.throws(() => new WardxCore(testSettings({ privacySalt: '' })).retentionActivity('user'), /privacySalt/);
});

test('retention channels and conversions carry only hashes and validated low-cardinality labels', () => {
  const core = new WardxCore(testSettings());
  const identity = {
    subject: subjectHash('test-salt', 'private-user'),
    salt: subjectHash('test-salt', 'wardx.retention.identity')
  };
  core.retentionActivity('private-user', { channel: 'google-ads' });
  core.retentionActivity('private-user', {});
  core.conversion('private-user', 'purchase');
  for (const invalid of [null, 'tiktok', ['tiktok']]) {
    assert.throws(() => core.retentionActivity('private-user', invalid), /options must be an object/);
  }
  assert.throws(() => core.retentionActivity('private-user', { source: 'tiktok' }), /unknown option: source/);
  for (const invalid of ['', 'TikTok', 'has space', '-lead', 'x'.repeat(65), 7, null]) {
    assert.throws(() => core.retentionActivity('private-user', { channel: invalid }), /channel must match/);
    assert.throws(() => core.conversion('private-user', invalid), /goal must match/);
  }
  assert.throws(() => core.conversion('  ', 'purchase'), /conversion requires a non-empty userId/);
  assert.throws(() => new WardxCore(testSettings({ privacySalt: '' })).conversion('user', 'purchase'), /privacySalt/);
  const events = core.snapshotFrame().frames.flatMap((frame) => frame.events);
  assert.deepEqual(events.map((row) => [row[1], row[2]]), [
    ['retention.activity', { ...identity, channel: 'google-ads' }],
    ['retention.activity', identity],
    ['retention.conversion', { ...identity, goal: 'purchase' }]
  ]);
  assert.equal(JSON.stringify(events).includes('private-user'), false);
});
