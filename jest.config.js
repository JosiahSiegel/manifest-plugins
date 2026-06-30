/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/*.spec.ts'],
  // Fetch external plugins (per external-plugins.json) before any test runs.
  // This is what makes the auto-discovery in src/registry/discover.ts pick up
  // plugins that live in separate repos. See docs/EXTERNAL_PLUGINS.md.
  globalSetup: '<rootDir>/scripts/jest-global-setup.js',
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.spec.ts',
    '!src/host/cli.ts',
    '!src/host/verify.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coverageThreshold: {
    global: {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
  },
  // The apply tool writes into upstream/provider-client.ts. Tests must
  // exercise it against copies (never the real file) and the path under
  // test is fully under the tempdir allocated per test.
  testTimeout: 30000,
};