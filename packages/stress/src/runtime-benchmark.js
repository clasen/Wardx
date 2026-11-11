import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testServerConfig } from '../../server/test/helpers.js';

const CLI_PATH = fileURLToPath(new URL('../../server/src/cli.js', import.meta.url));
const CLIENT_PATH = fileURLToPath(new URL('./runtime-benchmark-client.js', import.meta.url));
const RUNTIMES = { node: process.execPath, bun: 'bun' };
const ROUNDS = 3;
const STARTUPS = 25;
const STARTUP_METRIC = 'Import, create, and shut down (ms)';

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function format(value) {
  if (value >= 100) return value.toFixed(0);
  if (value >= 1) return value.toFixed(2);
  return value.toFixed(3);
}

function runClient(binary, args) {
  const result = spawnSync(binary, [CLIENT_PATH, ...args], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${binary} ${args[0]} failed\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

async function startServer(directory) {
  const configPath = join(directory, 'server.json');
  await writeFile(configPath, JSON.stringify({
    ...testServerConfig(),
    credentials: {
      'runtime-benchmark-key': {
        label: 'runtime-benchmark', project: 'demo', allowedRoles: ['backend'],
        trustedForDecisions: false, enabled: true
      }
    },
    diagnostics: { sink: 'none' }
  }));
  const server = spawn(process.execPath, [CLI_PATH, configPath], { stdio: ['pipe', 'ignore', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    server.stderr.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/wardx ingest listening on (\d+)/);
      if (match) resolve(Number(match[1]));
    });
    server.once('exit', (code) => reject(new Error(`wardx-server exited with ${code}\n${output}`)));
  });
  return { server, endpoint: `http://127.0.0.1:${port}` };
}

const directory = await mkdtemp(join(tmpdir(), 'wardx-runtime-benchmark-'));
const { server, endpoint } = await startServer(directory);
const measured = {};
try {
  for (let round = 0; round < ROUNDS; round++) {
    for (const [name, binary] of Object.entries(RUNTIMES)) {
      const { runtime, results } = JSON.parse(runClient(binary, ['measure', endpoint]).trim().split('\n').at(-1));
      measured[name] ??= { runtime, samples: {} };
      for (const [metric, value] of results) (measured[name].samples[metric] ??= []).push(value);
    }
  }
  for (const [name, binary] of Object.entries(RUNTIMES)) {
    const times = [];
    for (let i = 0; i < STARTUPS; i++) {
      const t0 = process.hrtime.bigint();
      runClient(binary, ['startup']);
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    measured[name].samples[STARTUP_METRIC] = times;
  }
} finally {
  server.kill();
  await rm(directory, { recursive: true, force: true });
}

process.stdout.write(`${cpus()[0].model}, ${process.platform} ${process.arch}, median of ${ROUNDS} rounds\n\n`);
process.stdout.write(`| Path | ${measured.node.runtime} | ${measured.bun.runtime} | Bun vs Node.js |\n`);
process.stdout.write('| --- | ---: | ---: | ---: |\n');
for (const metric of Object.keys(measured.node.samples)) {
  const node = median(measured.node.samples[metric]);
  const bun = median(measured.bun.samples[metric]);
  const ratio = node / bun;
  const comparison = ratio >= 1 ? `${ratio.toFixed(2)}× faster` : `${(1 / ratio).toFixed(2)}× slower`;
  process.stdout.write(`| ${metric} | ${format(node)} | ${format(bun)} | ${comparison} |\n`);
}
