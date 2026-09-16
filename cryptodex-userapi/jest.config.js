/**
 * Jest Configuration for Cryptodex User API
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

  // Module paths
  moduleDirectories: ['node_modules', '<rootDir>'],

  // Coverage configuration
  collectCoverageFrom: [
    'controllers/**/*.{js,ts}',
    'models/**/*.{js,ts}',
    'lib/**/*.{js,ts}',
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

  // Setup files
  setupFiles: ['<rootDir>/tests/env.setup.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],

  // Timeout for tests (in milliseconds)
  testTimeout: 30000,

  // Verbose output
  verbose: false,

  // Clear mocks between tests
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,

  // controllers/redis.controller.js opens its redis client at MODULE SCOPE and
  // exports nothing that can close it, so a worker that has loaded the real
  // controllers (which is the point of tests/integration) can never exit on its
  // own. The integration harness closes everything it owns - the HTTP server,
  // mongodb-memory-server, its own redis handle - before this takes effect, and
  // results are always reported before teardown, so this changes how the
  // process ENDS and nothing about what is asserted.
  forceExit: true,

  // RUN SERIALLY, for the same reason walletapi does. The integration suite
  // shares process-external state - one mongodb-memory-server instance and one
  // redis keyspace - without namespacing per worker, so under Jest's default
  // parallelism it fails nondeterministically. Measured on 2026-08-26 across
  // three runs of an unchanged tree: 8 failures, then 4, then 0 - and 552/552
  // repeatably with this set.
  //
  // In the config rather than on the `test` script so test:integration,
  // test:coverage, test:auth and any CI invocation inherit it too.
  //
  // The real fix is a per-worker database name and redis prefix; until then,
  // serial is the honest setting.
  maxWorkers: 1,

  // Ignore patterns
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/'
  ],

  // Transform ignore patterns
  transformIgnorePatterns: [
    '/node_modules/'
  ]
};
