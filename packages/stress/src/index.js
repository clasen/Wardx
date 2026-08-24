import { parseArgs } from 'node:util';
import { testA, testB, testC } from './client-benchmark.js';
import { testF } from './config-storm.js';
import { testG } from './experiment-consistency.js';
import { testE } from './fleet-simulator.js';
import { testD } from './server-benchmark.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    smoke: { type: 'boolean', default: false },
    full: { type: 'boolean', default: false },
    rate: { type: 'string' },
    duration: { type: 'string' },
    clients: { type: 'string' },
    subjects: { type: 'string' },
    profile: { type: 'string' }
  }
});

const which = (positionals[0] || 'all').toUpperCase();
const smoke = values.smoke || !values.full;
const durationMs = Number(values.duration || (smoke ? 2000 : 300_000));
const rate = Number(values.rate || (smoke ? 1000 : 5250));
const clients = Number(values.clients || (smoke ? 200 : 10_000));
const subjects = Number(values.subjects || (smoke ? 50_000 : 1_000_000));

const tests = {
  async A() {
    testA(smoke ? 2_000_000 : 10_000_000);
  },
  async B() {
    const rates = smoke ? [rate] : [10_000, 50_000, 100_000, 250_000];
    for (const r of rates) await testB({ rate: r, durationMs: smoke ? durationMs : 300_000 });
  },
  async C() {
    testC();
  },
  async D() {
    const profiles = values.profile ? [values.profile] : ['raw', 'persistence'];
    for (const profile of profiles) {
      await testD({ rate, durationMs, mode: smoke ? 'smoke' : 'full', profile });
    }
  },
  async E() {
    await testE({ clients, durationMs, syncIntervalMs: smoke ? 250 : 15_000 });
  },
  async F() {
    await testF({ durationMs, rate });
  },
  async G() {
    testG({ subjects });
  }
};

const selected = which === 'ALL' ? Object.keys(tests) : [which];
for (const name of selected) {
  if (!tests[name]) {
    throw new Error(`unknown test ${name}; expected A-G or all`);
  }
  await tests[name]();
}
