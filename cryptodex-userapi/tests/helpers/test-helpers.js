/**
 * Test Helper Functions
 *
 * Common utilities used across all authentication tests
 */

import jwt from 'jsonwebtoken';

/**
 * Generate a random string
 * @param {number} length - Length of string
 * @returns {string} Random string
 */
function randomString(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Generate a random hex string
 * @param {number} length - Length of hex string
 * @returns {string} Random hex string
 */
function generateHexString(length) {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Generate a valid MongoDB-like ObjectId
 * @returns {string} ObjectId string
 */
export function generateId() {
  return generateHexString(24);
}

/**
 * Generate a test email address
 * @returns {string} Test email
 */
export function generateEmail() {
  return `${randomString(8).toLowerCase()}@test.com`;
}

/**
 * Generate a test password
 * @returns {string} Test password
 */
export function generatePassword() {
  return `Test@123${randomString(4)}`;
}

/**
 * Generate a test JWT token
 * @param {Object} payload - Token payload
 * @param {string} secret - JWT secret
 * @returns {string} JWT token
 */
export const generateTestToken = (payload = {}, secret = 'test-secret-key') => {
  const defaultPayload = {
    _id: generateId(),
    uniqueId: generateId(),
    tokenId: generateId(),
    role: 'user',
    ...payload
  };

  const token = jwt.sign(defaultPayload, secret, { expiresIn: '24h' });
  return `Bearer ${token}`;
};

/**
 * Generate a test user object
 * @returns {Object} Test user
 */
export const generateTestUser = () => ({
  _id: generateId(),
  userId: generateId(),
  email: generateEmail(),
  firstName: 'Test',
  lastName: 'User',
  password: generatePassword(),
  status: 'verified',
  emailStatus: 'verified',
  phoneStatus: 'unverified',
  isBlock: false,
  login_attempt: 0,
  userLocked: 'false',
  google2Fa: {
    secret: '',
    uri: ''
  },
  role: 'user',
  type: 'basic_pending',
  refferalCode: randomString(8).toUpperCase(),
  otp: '',
  otptime: null
});

/**
 * Generate login history object
 * @returns {Object} Login history data
 */
export const generateLoginHistory = () => ({
  ipaddress: '192.168.1.1',
  countryName: 'United States',
  countryCode: 'US',
  region: 'California',
  broswername: 'Chrome',
  ismobile: false,
  os: 'Windows'
});

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

/**
 * Wait for a specified time (useful for async tests)
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
export const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Generate an Ethereum-style address
 * @returns {string} Ethereum address
 */
export function generateEthereumAddress() {
  return '0x' + generateHexString(40);
}

/**
 * Generate a random currency code
 * @returns {string} Currency code
 */
export function generateCurrencyCode() {
  const codes = ['BTC', 'ETH', 'USDT', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'DOT', 'LINK'];
  return codes[Math.floor(Math.random() * codes.length)];
}

/**
 * Random choice from array
 * @param {Array} array - Array to choose from
 * @returns {*} Random element
 */
export function randomChoice(array) {
  return array[Math.floor(Math.random() * array.length)];
}

/**
 * Generate a random number between min and max
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {number} Random number
 */
export function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
