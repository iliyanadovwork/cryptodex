/**
 * Test Setup File
 */

// Suppress Mongoose deprecation warnings in tests
import mongoose from 'mongoose';
mongoose.set('strictQuery', true);

jest.setTimeout(60000);

global.testEnv = {
  isTest: true,
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/cryptodex_spot_test'
};

global.console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: console.error,
};

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
