/**
 * Opt-in end-to-end tests against a running backend. Requires E2E_API_BASE_URL, for example
 * http://127.0.0.1:8000. Run with: npm run test:e2e
 */
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/e2e'],
  testMatch: ['**/*.e2e.test.ts'],
  testTimeout: 180_000,
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { module: 'commonjs', target: 'es2022', types: ['jest', 'node'] } }],
  },
};
