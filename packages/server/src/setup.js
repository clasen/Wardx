import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { CredentialRegistry } from './auth/CredentialRegistry.js';

const SECRETS_FILE = 'secrets.json';
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export function generateSecret(prefix) {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

function credentialRecord({ project, role, trusted, label }) {
  return {
    label: label ?? `${project}-${role}`,
    project,
    allowedRoles: [role],
    trustedForDecisions: trusted,
    enabled: true
  };
}

function credentialKey(trusted) {
  return generateSecret(trusted ? 'wdx_srv' : 'wdx_pub');
}

export function parseClientSpec(spec) {
  const match = /^([^:]+):(trusted|public)$/.exec(spec);
  if (!match || match[1] === '*') {
    throw new Error(`client must be role:trusted or role:public, got ${spec}`);
  }
  return { role: match[1], trusted: match[2] === 'trusted' };
}

function writeSecrets(dir, secrets) {
  new CredentialRegistry(secrets.credentials);
  const path = join(dir, SECRETS_FILE);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}

function readSecrets(dir) {
  const path = join(dir, SECRETS_FILE);
  if (!existsSync(path)) throw new Error(`${path} not found; run wardx-server init first`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function mcpUrl(dir) {
  return `https://${basename(resolve(dir))}/mcp`;
}

const templates = {
  'package.json': (domain) => `${JSON.stringify({
    name: domain,
    private: true,
    type: 'module',
    engines: { node: '>=20' },
    dependencies: { '@wardx/server': `^${PACKAGE_VERSION}` }
  }, null, 2)}\n`,
  'index.js': () => `import { createWardxHandler } from '@wardx/server';
import config from './config.cjs';

const { handler, stop } = await createWardxHandler(config);

export { stop };
export default function siteApp(virtualServer) {
  virtualServer.onClose(stop);
  return handler;
}
`,
  'config.cjs': (domain, project) => `const path = require('node:path');
const secrets = require('./${SECRETS_FILE}');

module.exports = {
  credentials: secrets.credentials,
  sqlite: { path: path.join(__dirname, 'wardx.sqlite') },
  mcpHttp: { enabled: true, bearerToken: secrets.mcpToken },
  projects: {
    ${/^[A-Za-z_$][\w$]*$/.test(project) ? project : JSON.stringify(project)}: { version: 1, values: {}, keyRoles: {}, experiments: [] }
  }
};
`,
  '.gitignore': () => `node_modules/\n${SECRETS_FILE}\nwardx.sqlite*\n`
};

export function initSite({ dir, project, clients }) {
  if (clients.length === 0) throw new Error('init needs at least one --client role:trusted|public');
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`${dir} already exists and is not empty`);
  mkdirSync(dir, { recursive: true });
  const domain = basename(resolve(dir));
  const credentials = {};
  for (const client of clients) credentials[credentialKey(client.trusted)] = credentialRecord({ project, ...client });
  const secrets = { mcpToken: generateSecret('wdx_mcp'), credentials };
  writeSecrets(dir, secrets);
  for (const [file, render] of Object.entries(templates)) {
    writeFileSync(join(dir, file), render(domain, project), { flag: 'wx' });
  }
  return secrets;
}

export function addCredential({ dir, project, role, trusted, label }) {
  const secrets = readSecrets(dir);
  const key = credentialKey(trusted);
  const record = credentialRecord({ project, role, trusted, label });
  writeSecrets(dir, { ...secrets, credentials: { ...secrets.credentials, [key]: record } });
  return { key, record };
}

export function rotateMcpToken({ dir }) {
  const secrets = readSecrets(dir);
  const mcpToken = generateSecret('wdx_mcp');
  writeSecrets(dir, { ...secrets, mcpToken });
  return mcpToken;
}

export function formatCredential(key, record) {
  const trust = record.trustedForDecisions ? 'trusted' : 'public';
  return `  ${record.label}  project ${record.project}  role ${record.allowedRoles.join(',')}  ${trust}\n    ${key}\n`;
}

export function formatMcpClients(url, token) {
  return [
    'Claude Code:',
    `  claude mcp add --transport http --scope user wardx ${url} --header "Authorization: Bearer ${token}"`,
    'Codex (~/.codex/config.toml):',
    '  [mcp_servers.wardx]',
    `  url = "${url}"`,
    `  http_headers = { Authorization = "Bearer ${token}" }`,
    ''
  ].join('\n');
}
