import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WardxCore, loadSdkDefaults } from '../src/index.js';

function core(tracer) {
  const settings = {
    ...loadSdkDefaults(),
    endpoint: 'http://127.0.0.1:1',
    projectKey: 'k',
    project: 'p',
    role: 'client',
    appVersion: '1',
    environment: 'test',
    privacySalt: 'k'
  };
  if (tracer !== undefined) settings.tracer = tracer;
  return new WardxCore(settings);
}

function collector() {
  const records = [];
  return {
    records,
    measure(record) {
      records.push({ hook: 'measure', ...record });
    },
    event(record) {
      records.push({ hook: 'event', ...record });
    },
    log(record) {
      records.push({ hook: 'log', ...record });
    },
    frame(record) {
      records.push({ hook: 'frame', ...record });
    }
  };
}

test('without a tracer, counter returns the registry series', () => {
  const engine = core();
  const a = engine.counter('match.completed', { mode: 'ranked' });
  const b = engine.counter('match.completed', { mode: 'ranked' });
  assert.equal(a, b);
  a.inc();
  assert.equal(a.value, 1);
});

test('tracer receives one record per measure, event, and log', () => {
  const tracer = collector();
  const engine = core(tracer);
  engine.counter('match.completed', { mode: 'ranked' }).inc();
  engine.counter('coins.awarded').add(25);
  engine.gauge('players.online').set(12);
  engine.histogram('request.duration').observe(42, { grantId: 'g-1' });
  engine.event('purchase', { product: 'premium' });
  engine.log.info('match_started', { players: 4 });

  assert.equal(tracer.records.length, 6);
  assert.deepEqual(tracer.records[0], {
    hook: 'measure',
    type: 'counter',
    name: 'match.completed',
    dims: { mode: 'ranked' },
    op: 'inc',
    value: 1,
    noop: false
  });
  assert.equal(tracer.records[1].op, 'add');
  assert.equal(tracer.records[1].value, 25);
  assert.equal(tracer.records[2].type, 'gauge');
  assert.equal(tracer.records[3].type, 'histogram');
  assert.deepEqual(tracer.records[3].attrs, { grantId: 'g-1' });
  assert.equal(tracer.records[4].hook, 'event');
  assert.equal(tracer.records[4].dropped, false);
  assert.equal(tracer.records[5].hook, 'log');
  assert.equal(tracer.records[5].level, 'info');
});

test('tracer wraps the same series once', () => {
  const tracer = collector();
  const engine = core(tracer);
  const a = engine.counter('q');
  const b = engine.counter('q');
  assert.equal(a, b);
  a.inc();
  b.inc();
  assert.equal(tracer.records.length, 2);
});

test('timer stop traces as a histogram observe', async () => {
  const tracer = collector();
  const engine = core(tracer);
  const end = engine.timer('matchmaking.duration');
  await new Promise((resolve) => setTimeout(resolve, 5));
  end({ result: 'success' });
  assert.equal(tracer.records.length, 1);
  assert.equal(tracer.records[0].type, 'histogram');
  assert.equal(tracer.records[0].name, 'matchmaking.duration');
  assert.equal(tracer.records[0].dims.result, 'success');
  assert.ok(tracer.records[0].value >= 5);
});

test('cardinality drop still traces with noop true', () => {
  const tracer = collector();
  const engine = core(tracer);
  const tight = new WardxCore({
    ...engine.settings,
    maxSeriesPerMetric: 1,
    tracer
  });
  tight.counter('q', { n: 1 }).inc();
  tight.counter('q', { n: 2 }).inc();
  const noop = tracer.records.find((row) => row.noop === true);
  assert.ok(noop);
  assert.equal(noop.name, 'q');
  assert.deepEqual(noop.dims, { n: 2 });
});

test('snapshotFrame emits a frame summary, not the wire arrays', () => {
  const tracer = collector();
  const engine = core(tracer);
  engine.counter('match.completed').inc();
  engine.counter('match.completed').inc();
  engine.event('purchase');
  const fitted = engine.snapshotFrame();
  const frame = tracer.records.find((row) => row.hook === 'frame');
  assert.ok(frame);
  assert.equal(frame.seq, fitted.frame.seq);
  assert.ok(frame.counters >= 1);
  assert.equal(frame.events, 1);
  assert.equal(frame.droppedLogs, 0);
});

test('a partial tracer does not require unused hooks', () => {
  const measures = [];
  const engine = core({ measure: (record) => measures.push(record) });
  engine.counter('q').inc();
  engine.event('e');
  engine.log.debug('d');
  engine.snapshotFrame();
  assert.equal(measures.length, 1);
});
