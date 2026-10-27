#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadServerConfig, startServer } from './server.js';
import { startMcpStdio } from './mcp/stdio.js';
import {
  addCredential,
  formatCredential,
  formatMcpClients,
  initSite,
  issueMcpToken,
  mcpUrl,
  parseClientSpec,
  revokeMcpToken,
  rotateMcpToken,
  siteLoadsScopedTokens
} from './setup.js';

const USAGE = `Usage:
  wardx-server <config.json>
  wardx-server init <site-dir> --project <name> --client <role:trusted|public> [--client ...]
  wardx-server credential add <site-dir> --project <name> --role <role> [--trusted] [--label <label>]
  wardx-server mcp-token <site-dir>
  wardx-server mcp-token <site-dir> --name <name> [--project <name> ...]
  wardx-server mcp-token <site-dir> --name <name> --revoke
`;

function parse(args, options) {
  const { values, positionals } = parseArgs({ args, options, allowPositionals: true });
  if (positionals.length !== 1) throw new Error(USAGE);
  return { dir: positionals[0], ...values };
}

function required(value, flag) {
  if (!value) throw new Error(`--${flag} is required\n\n${USAGE}`);
  return value;
}

const commands = {
  init(args) {
    const { dir, project, client = [] } = parse(args, {
      project: { type: 'string' },
      client: { type: 'string', multiple: true }
    });
    const secrets = initSite({ dir, project: required(project, 'project'), clients: client.map(parseClientSpec) });
    process.stdout.write(`Created ${dir}. Secrets are stored in ${dir}/secrets.json (git-ignored).\n\nClient keys:\n`);
    for (const [key, record] of Object.entries(secrets.credentials)) process.stdout.write(formatCredential(key, record));
    process.stdout.write(`\nMCP:\n${formatMcpClients(mcpUrl(dir), secrets.mcpToken)}\nNext: install dependencies in ${dir}.\n`);
  },
  credential([action, ...args]) {
    if (action !== 'add') throw new Error(USAGE);
    const { dir, project, role, trusted = false, label } = parse(args, {
      project: { type: 'string' },
      role: { type: 'string' },
      trusted: { type: 'boolean' },
      label: { type: 'string' }
    });
    const { key, record } = addCredential({
      dir,
      project: required(project, 'project'),
      ...parseClientSpec(`${required(role, 'role')}:${trusted ? 'trusted' : 'public'}`),
      label
    });
    process.stdout.write(`Added credential:\n${formatCredential(key, record)}\n`);
    process.stdout.write(`Project ${project} must exist in the site configuration. Restart the site to apply.\n`);
  },
  'mcp-token'(args) {
    const { dir, name, project = [], revoke = false } = parse(args, {
      name: { type: 'string' },
      project: { type: 'string', multiple: true },
      revoke: { type: 'boolean' }
    });
    if (name === undefined) {
      if (project.length > 0 || revoke) throw new Error(`--project and --revoke need --name\n\n${USAGE}`);
      const token = rotateMcpToken({ dir });
      process.stdout.write(`Rotated the MCP token. Restart the site to apply, then update each agent:\n\n`);
      process.stdout.write(formatMcpClients(mcpUrl(dir), token));
      return;
    }
    if (revoke) {
      if (project.length > 0) throw new Error(`--revoke does not take --project\n\n${USAGE}`);
      revokeMcpToken({ dir, name });
      process.stdout.write(`Revoked MCP token ${name}. Restart the site to apply.\n`);
      return;
    }
    const entry = issueMcpToken({ dir, name, projects: project });
    process.stdout.write(`MCP token ${name} for projects ${entry.projects.join(', ')}. `);
    process.stdout.write(`Each project must exist in the site configuration. Restart the site to apply, then update the agent:\n\n`);
    process.stdout.write(formatMcpClients(mcpUrl(dir), entry.bearerToken));
    if (!siteLoadsScopedTokens(dir)) {
      process.stdout.write(`\nThis site's config.cjs does not load scoped tokens yet. Add tokens to mcpHttp:\n`);
      process.stdout.write(`  mcpHttp: { enabled: true, bearerToken: secrets.mcpToken, tokens: secrets.mcpTokens },\n`);
    }
  }
};

async function serve(path) {
  const { server, address, config } = await startServer(loadServerConfig(path));
  const port = typeof address === 'object' ? address.port : address;
  process.stderr.write(`wardx ingest listening on ${port}\n`);
  if (config.mcpHttp.enabled) {
    process.stderr.write(`wardx MCP HTTP serving ${config.mcpHttp.path}\n`);
  }
  if (!process.stdin.isTTY) {
    await startMcpStdio(server.wardx.control);
  }
}

const [first, ...rest] = process.argv.slice(2);
if (Object.hasOwn(commands, first)) {
  try {
    commands[first](rest);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
} else {
  await serve(first);
}
