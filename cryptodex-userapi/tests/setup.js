/**
 * Test Setup File
 *
 * Setup for authentication and authorization testing
 */

// Set test timeout
jest.setTimeout(30000);

// Global test utilities
global.testEnv = {
  isTest: true,
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/cryptodex_user_test'
};

// Mock console methods to reduce noise during tests
global.console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  // Keep error for debugging test failures
  error: console.error,
};

// Handle unhandled promise rejections in tests
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
