#!/usr/bin/env node
import { loadServerConfig, startServer } from './server.js';
import { startMcpStdio } from './mcp/stdio.js';

const { server, address, mcpAddress } = await startServer(loadServerConfig(process.argv[2]));
const port = typeof address === 'object' ? address.port : address;
process.stderr.write(`wardx ingest listening on ${port}\n`);
if (mcpAddress) {
  const mcpPort = typeof mcpAddress === 'object' ? mcpAddress.port : mcpAddress;
  process.stderr.write(`wardx MCP HTTP listening on ${mcpPort}\n`);
}
if (!process.stdin.isTTY) {
  await startMcpStdio(server.wardx.control);
}
