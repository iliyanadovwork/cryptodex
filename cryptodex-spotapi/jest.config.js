/**
 * Jest Configuration for Cryptodex Spot API
 */

export default {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: [
    '**/tests/**/*.test.js',
    '**/tests/**/*.spec.js'
  ],
  moduleDirectories: ['node_modules', '<rootDir>'],
  collectCoverageFrom: [
    'controllers/**/*.{js,ts}',
    'models/**/*.{js,ts}',
    'lib/**/*.{js,ts}',
    '!**/node_modules/**',
    '!**/dist/**'
  ],
  coverageThreshold: {
    global: {
      branches: 50,
      functions: 50,
      lines: 50,
      statements: 50
    }
  },
  coverageReporters: ['text', 'lcov', 'html'],
  transform: {
    '^.+\\.(js|jsx)$': 'babel-jest'
  },
  setupFiles: ['<rootDir>/tests/env.setup.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  testTimeout: 60000,
  verbose: false,
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
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/'
  ],
  transformIgnorePatterns: [
    '/node_modules/'
  ]
};
