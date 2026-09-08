import { resolveSettings } from '@wardx/core';
import { WardxNode } from './WardxNode.js';
import { createConsoleTracer } from './trace/createConsoleTracer.js';

export function createWardx(options) {
  if (options?.enabled !== undefined && typeof options.enabled !== 'boolean') {
    throw new Error('enabled must be a boolean');
  }
  return new WardxNode(options?.enabled === false ? { enabled: false } : resolveSettings(options));
}

export { WardxNode, createConsoleTracer };
