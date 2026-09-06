#!/usr/bin/env node
import { backup, restore, verify } from './recovery.js';

const [command, ...args] = process.argv.slice(2);
try {
  let result;
  if (command === 'backup' && args.length === 2) result = await backup(...args);
  else if (command === 'verify' && args.length === 1) result = await verify(...args);
  else if (command === 'restore' && args.length === 2) result = await restore(...args);
  else throw new Error('Usage: wardx-recovery backup <config.json> <new-directory> | verify <backup-directory> | restore <backup-directory> <new-directory>');
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
