/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/unit'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { module: 'commonjs', target: 'es2022', types: ['jest', 'node'] } }],
  },
  collectCoverageFrom: ['src/core/**/*.ts', 'src/ui/presentation.ts'],
  coverageThreshold: {
    global: { lines: 85, statements: 85, functions: 85 },
  },
};
