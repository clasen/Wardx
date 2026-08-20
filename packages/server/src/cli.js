#!/usr/bin/env node
import { loadServerConfig, startServer } from './server.js';

const { address } = await startServer(loadServerConfig(process.argv[2]));
const port = typeof address === 'object' ? address.port : address;
process.stdout.write(`wardx ingest listening on ${port}\n`);
