/**
 * Jest Configuration for Cryptodex Wallet API
 */

export default {
  // Environment
  testEnvironment: 'node',

  // Root directories
  roots: ['<rootDir>/tests'],

  // Test file patterns
  testMatch: [
    '**/tests/**/*.test.js',
    '**/tests/**/*.spec.js'
  ],

  // Test path ignore patterns
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/'
  ],

  // Module paths
  moduleDirectories: ['node_modules', '<rootDir>'],

  // Coverage configuration
  collectCoverageFrom: [
    'controllers/**/*.{js,ts}',
    'models/**/*.{js,ts}',
    'services/**/*.{js,ts}',
    'routes/**/*.{js,ts}',
    '!**/node_modules/**',
    '!**/dist/**'
  ],

  // Coverage thresholds
  coverageThreshold: {
    global: {
      branches: 50,
      functions: 50,
      lines: 50,
      statements: 50
    }
  },

  // Coverage reporters
  coverageReporters: ['text', 'lcov', 'html'],

  // Transform configuration
  transform: {
    '^.+\\.(js|jsx)$': 'babel-jest'
  },

  // Transform ignore patterns
  transformIgnorePatterns: [
    '/node_modules/(?!(mongodb-memory-server))'
  ],

  // Setup files
  setupFiles: ['<rootDir>/tests/env.setup.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],

  // Timeout for tests (in milliseconds)
  testTimeout: 60000,

  // controllers/redis.controller.js opens its redis client at MODULE SCOPE and
  // exports nothing that can close it, so a worker that has loaded the real
  // controllers (which is the point of tests/integration) can never exit on its
  // own. The integration harness closes everything it owns - the HTTP server,
  // mongodb-memory-server, its own redis handle - before this takes effect, and
  // results are always reported before teardown, so this changes how the
  // process ENDS and nothing about what is asserted.
  forceExit: true,

  // RUN SERIALLY. The integration suites share process-external state - one
  // mongodb-memory-server instance and one redis keyspace - and do not namespace
  // per worker, so under Jest's default parallelism they interfere with each
  // other and fail nondeterministically. Measured on 2026-08-26 across three
  // runs of an unchanged tree: 9, then 2, then 6 failures, with a DIFFERENT set
  // of test names each time, while every one of those tests passes in isolation.
  // Serially the suite is 560/560, repeatably.
  //
  // This lives in the config rather than as `--runInBand` on the `test` script
  // so that `test:integration`, `test:coverage` and any CI invocation get it too
  // - the flake is a property of these tests, not of one entry point.
  //
  // The real fix is to give each worker its own database name and redis prefix;
  // until then, serial is the honest setting. It costs a few seconds: the whole
  // suite runs in well under a minute either way.
  maxWorkers: 1,

  // Verbose output
  verbose: true,

  // Clear mocks between tests
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true
};
