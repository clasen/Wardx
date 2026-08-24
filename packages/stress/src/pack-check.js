import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const PACKAGES = Object.freeze([
  { name: '@wardx/core', directory: 'packages/core' },
  { name: 'wardx', directory: 'packages/node' },
  { name: '@wardx/server', directory: 'packages/server' }
]);

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPOSITORY_ROOT,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(' ')} failed with ${signal ? `signal ${signal}` : `exit ${code}`}\n${stdout}${stderr}`
        )
      );
    });
  });
}

async function pack(packageInfo, tarballDirectory, npmEnvironment) {
  const { stdout } = await run(NPM, [
    'pack',
    join(REPOSITORY_ROOT, packageInfo.directory),
    '--json',
    '--pack-destination',
    tarballDirectory
  ], { env: npmEnvironment });
  const result = JSON.parse(stdout);
  assert.equal(result.length, 1, `${packageInfo.name} npm pack must return exactly one tarball`);
  assert.equal(result[0].name, packageInfo.name);
  return join(tarballDirectory, result[0].filename);
}

function waitForPort(stderr) {
  return new Promise((resolvePromise, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`packaged server did not report its port:\n${output}`)), 10_000);
    stderr.on('data', (chunk) => {
      output += chunk.toString('utf8');
      const match = output.match(/wardx ingest listening on (\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolvePromise(Number(match[1]));
    });
    stderr.on('error', reject);
  });
}

function waitForExit(child) {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('packaged server did not stop after SIGTERM'));
    }, 10_000);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 || code === 143 || signal === 'SIGTERM') {
        resolvePromise();
        return;
      }
      reject(new Error(`packaged server stopped with ${signal ? `signal ${signal}` : `exit ${code}`}`));
    });
  });
}

async function assertInstalledCopies(projectDirectory) {
  const installedProject = await realpath(projectDirectory);
  for (const packageInfo of PACKAGES) {
    const packagePath = join(projectDirectory, 'node_modules', ...packageInfo.name.split('/'));
    const installedPath = await realpath(packagePath);
    const location = relative(installedProject, installedPath);
    assert.ok(!location.startsWith('..'), `${packageInfo.name} resolved outside the clean install: ${installedPath}`);
    assert.ok(
      location === join('node_modules', ...packageInfo.name.split('/')),
      `${packageInfo.name} resolved through a symlink instead of its tarball: ${installedPath}`
    );
  }
}

async function verifyImports(projectDirectory) {
  const scriptPath = join(projectDirectory, 'verify-imports.mjs');
  await writeFile(
    scriptPath,
    [
      "import assert from 'node:assert/strict';",
      "import { WardxCore } from '@wardx/core';",
      "import { createWardx } from 'wardx';",
      "import { createIngestServer } from '@wardx/server';",
      "assert.equal(typeof WardxCore, 'function');",
      "assert.equal(typeof createWardx, 'function');",
      "assert.equal(typeof createIngestServer, 'function');",
      "process.stdout.write('packaged imports ok\\n');",
      ''
    ].join('\n'),
    'utf8'
  );
  await run(process.execPath, [scriptPath], {
    cwd: projectDirectory,
    env: { ...process.env, NODE_PATH: '' }
  });
}

async function verifyPackagedBinary(projectDirectory) {
  const sourceConfig = JSON.parse(await readFile(join(REPOSITORY_ROOT, 'config/production.json'), 'utf8'));
  const configPath = join(projectDirectory, 'wardx-server.json');
  await writeFile(
    configPath,
    `${JSON.stringify({ ...sourceConfig, host: '127.0.0.1', port: 0, sink: 'null' }, null, 2)}\n`,
    'utf8'
  );
  const binary = join(projectDirectory, 'node_modules', '.bin', process.platform === 'win32' ? 'wardx-server.cmd' : 'wardx-server');
  const child = spawn(binary, [configPath], {
    cwd: projectDirectory,
    env: { ...process.env, NODE_PATH: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exit = waitForExit(child);
  try {
    const port = await waitForPort(child.stderr);
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    child.kill('SIGTERM');
    await exit;
  } catch (error) {
    child.kill('SIGKILL');
    await exit.catch(() => {});
    throw error;
  }
}

export async function checkPackages() {
  const directory = await mkdtemp(join(tmpdir(), 'wardx-pack-check-'));
  try {
    const tarballDirectory = join(directory, 'tarballs');
    const projectDirectory = join(directory, 'project');
    const cacheDirectory = join(directory, 'npm-cache');
    const npmEnvironment = { ...process.env, npm_config_cache: cacheDirectory };
    await Promise.all([mkdir(tarballDirectory), mkdir(projectDirectory), mkdir(cacheDirectory)]);
    const tarballs = await Promise.all(
      PACKAGES.map((packageInfo) => pack(packageInfo, tarballDirectory, npmEnvironment))
    );
    const dependencies = Object.fromEntries(PACKAGES.map((packageInfo, index) => [packageInfo.name, `file:${tarballs[index]}`]));
    await writeFile(
      join(projectDirectory, 'package.json'),
      `${JSON.stringify({ name: 'wardx-packed-artifact-check', private: true, type: 'module', dependencies }, null, 2)}\n`,
      'utf8'
    );
    await run(NPM, ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: projectDirectory,
      env: npmEnvironment
    });
    await assertInstalledCopies(projectDirectory);
    await verifyImports(projectDirectory);
    await verifyPackagedBinary(projectDirectory);
    process.stdout.write('pack:check passed: tarballs installed cleanly and packaged wardx-server served /health\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await checkPackages();
