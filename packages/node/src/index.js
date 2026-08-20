import { resolveSettings } from '@wardx/core';
import { WardxNode } from './WardxNode.js';

export function createWardx(options) {
  return new WardxNode(resolveSettings(options));
}

export { WardxNode };
