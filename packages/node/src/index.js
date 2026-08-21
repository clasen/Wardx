import { resolveSettings } from '@wardx/core';
import { WardxNode } from './WardxNode.js';
import { createConsoleTracer } from './trace/createConsoleTracer.js';

export function createWardx(options) {
  return new WardxNode(resolveSettings(options));
}

export { WardxNode, createConsoleTracer };
