#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadServerConfig, startServer } from './server.js';
import { startMcpStdio } from './mcp/stdio.js';
import {
  addCredential,
  formatCredential,
  formatMcpClients,
  initSite,
  mcpUrl,
  parseClientSpec,
  rotateMcpToken
} from './setup.js';

const USAGE = `Usage:
  wardx-server <config.json>
  wardx-server init <site-dir> --project <name> --client <role:trusted|public> [--client ...]
  wardx-server credential add <site-dir> --project <name> --role <role> [--trusted] [--label <label>]
  wardx-server mcp-token <site-dir>
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
    const { dir } = parse(args, {});
    const token = rotateMcpToken({ dir });
    process.stdout.write(`Rotated the MCP token. Restart the site to apply, then update each agent:\n\n`);
    process.stdout.write(formatMcpClients(mcpUrl(dir), token));
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
