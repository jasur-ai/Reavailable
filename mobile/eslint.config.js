const { defineConfig } = require('eslint/config');
const expo = require('eslint-config-expo/flat');

module.exports = defineConfig([
  ...expo,
  {
    ignores: ['node_modules/', 'dist/', '.expo/', 'coverage/', 'android/', 'ios/'],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The app never logs: transcripts and tokens must not reach device logs.
    files: ['App.tsx', 'index.ts', 'src/**/*.ts', 'src/**/*.tsx'],
    rules: {
      'no-console': 'error',
    },
  },
]);
