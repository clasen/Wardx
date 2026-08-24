import js from '@eslint/js';

const nodeGlobals = Object.fromEntries(
  [
    'AbortController',
    'Blob',
    'Buffer',
    'Headers',
    'Request',
    'Response',
    'TextEncoder',
    'URL',
    'URLSearchParams',
    'clearImmediate',
    'clearInterval',
    'clearTimeout',
    'console',
    'fetch',
    'global',
    'performance',
    'process',
    'queueMicrotask',
    'setImmediate',
    'setInterval',
    'setTimeout',
    'structuredClone'
  ].map((name) => [name, 'readonly'])
);

export default [
  { ignores: ['node_modules/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: nodeGlobals
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  }
];
