/**
 * Test Setup File
 *
 * Simple setup for initial testing
 * MongoDB Memory Server setup will be added incrementally
 */

// Set test timeout
jest.setTimeout(30000);

// Global test utilities
global.testEnv = {
  isTest: true,
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/cryptodex_wallet_test'
};

// Handle unhandled promise rejections in tests
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
