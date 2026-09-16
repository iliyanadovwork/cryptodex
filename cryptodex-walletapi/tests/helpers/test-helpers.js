/**
 * Test Helper Functions
 *
 * Common utilities used across all tests
 */

import jwt from 'jsonwebtoken';

/**
 * Generate a valid JWT token for testing
 * @param {Object} payload - Token payload
 * @param {string} secret - JWT secret (defaults to test secret)
 * @returns {string} JWT token
 */
export const generateTestToken = (payload = {}, secret = 'test-secret-key') => {
  const defaultPayload = {
    id: generateId(),
    email: generateEmail(),
    ...payload
  };

  return jwt.sign(defaultPayload, secret, { expiresIn: '1h' });
};

/**
 * Generate a test user object
 * @returns {Object} Test user
 */
export const generateTestUser = () => ({
  _id: generateId(),
  email: generateEmail(),
  firstName: generateFirstName(),
  lastName: generateLastName(),
  password: '$2b$10$' + generateString(53), // mock bcrypt hash
  twoFactorSecret: null,
  isVerified: true,
  status: 'active'
});

/**
 * Generate test wallet data
 * @param {Object} overrides - Override default values
 * @returns {Object} Test wallet
 */
export const generateTestWallet = (overrides = {}) => ({
  userId: generateId(),
  currencyId: generateId(),
  currencySymbol: generateCurrencyCode(),
  balance: generateAmount(0, 10000, 4),
  frozenBalance: generateAmount(0, 1000, 4),
  ...overrides
});

/**
 * Generate test currency data
 * @param {Object} overrides - Override default values
 * @returns {Object} Test currency
 */
export const generateTestCurrency = (overrides = {}) => ({
  symbol: generateCurrencyCode(),
  type: 'crypto',
  status: 'active',
  image: generateUrl(),
  depositStatus: true,
  withdrawStatus: true,
  transferStatus: true,
  network: 'ERC20',
  contractAddress: generateEthereumAddress(),
  decimals: randomInt(6, 18),
  minDeposit: generateAmount(0.001, 0.1, 6),
  maxWithdraw: generateAmount(1000, 100000, 2),
  withdrawFee: generateAmount(0.0001, 0.01, 6),
  ...overrides
});

/**
 * Generate test transaction data
 * @param {Object} overrides - Override default values
 * @returns {Object} Test transaction
 */
export const generateTestTransaction = (overrides = {}) => ({
  userId: generateId(),
  type: randomChoice(['deposit', 'withdraw', 'transfer']),
  currencySymbol: generateCurrencyCode(),
  amount: generateAmount(10, 1000, 4),
  status: randomChoice(['pending', 'completed', 'failed']),
  txHash: generateHexString(64),
  fromAddress: generateEthereumAddress(),
  toAddress: generateEthereumAddress(),
  ...overrides
});

/**
 * Generate test deposit/withdrawal event
 * @param {Object} overrides - Override default values
 * @returns {Object} Test event
 */
export const generateTestDepositEvent = (overrides = {}) => ({
  userId: generateId(),
  currencySymbol: generateCurrencyCode(),
  amount: generateAmount(10, 1000, 4),
  address: generateEthereumAddress(),
  txHash: generateHexString(64),
  confirmations: randomInt(0, 12),
  status: randomChoice(['pending', 'confirming', 'confirmed', 'failed']),
  ...overrides
});

/**
 * Wait for a specified time (useful for async tests)
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
export const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Create a mock response object
 * @returns {Object} Mock Express response
 */
export const mockResponse = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  return res;
};

/**
 * Create a mock request object
 * @param {Object} overrides - Override default values
 * @returns {Object} Mock Express request
 */
export const mockRequest = (overrides = {}) => ({
  user: { id: generateId() },
  body: {},
  params: {},
  query: {},
  headers: {},
  ...overrides
});

// === Helper functions for generating test data ===

function generateId() {
  return randomString(12);
}

function generateString(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateHexString(length) {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateEmail() {
  return `${randomString(8).toLowerCase()}@${randomString(6).toLowerCase()}.com`;
}

function generateFirstName() {
  const names = ['John', 'Jane', 'Bob', 'Alice', 'Charlie', 'Diana', 'Eve', 'Frank'];
  return randomChoice(names);
}

function generateLastName() {
  const names = ['Doe', 'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Davis', 'Miller'];
  return randomChoice(names);
}

function generateCurrencyCode() {
  const codes = ['BTC', 'ETH', 'USDT', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'DOT', 'LINK'];
  return randomChoice(codes);
}

function generateUrl() {
  return `https://example.com/${randomString(8).toLowerCase()}.png`;
}

function generateEthereumAddress() {
  return '0x' + generateHexString(40);
}

function generateAmount(min, max, decimals) {
  const num = Math.random() * (max - min) + min;
  return num.toFixed(decimals);
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomChoice(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function randomString(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Generate random crypto addresses for different chains
 */
export const generateCryptoAddresses = () => ({
  BTC: randomString(34).toLowerCase(),
  ETH: generateEthereumAddress(),
  USDT_ERC20: generateEthereumAddress(),
  TRX: randomString(34).toLowerCase(),
  BNB: randomString(42).toLowerCase()
});
