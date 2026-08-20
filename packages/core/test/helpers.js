import { loadSdkDefaults } from '../src/settings.js';

export function testSettings(overrides = {}) {
  return {
    ...loadSdkDefaults(),
    endpoint: 'http://127.0.0.1:9',
    projectKey: 'test-key',
    project: 'demo',
    appVersion: '0.0.0',
    environment: 'test',
    privacySalt: 'test-salt',
    ...overrides
  };
}
