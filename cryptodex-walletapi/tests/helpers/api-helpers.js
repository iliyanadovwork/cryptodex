/**
 * API Test Helpers
 *
 * Utilities for making API requests in tests
 */

import axios from 'axios';

/**
 * Create an authenticated API request helper
 * @param {string} baseURL - Base URL of the API
 * @returns {Object} API helper object
 */
export const createApiClient = (baseURL = 'http://localhost:3002') => {
  const client = axios.create({
    baseURL,
    validateStatus: () => true // Don't throw on any status code
  });

  return {
    /**
     * Set authentication token
     * @param {string} token - JWT token
     */
    setToken(token) {
      this.token = token;
    },

    /**
     * Make a GET request
     * @param {string} path - Request path
     * @param {Object} options - Axios options
     * @returns {Promise<Object>} Response
     */
    async get(path, options = {}) {
      return client.get(path, {
        ...options,
        headers: {
          ...this._getHeaders(),
          ...options.headers
        }
      });
    },

    /**
     * Make a POST request
     * @param {string} path - Request path
     * @param {Object} data - Request body
     * @param {Object} options - Axios options
     * @returns {Promise<Object>} Response
     */
    async post(path, data = {}, options = {}) {
      return client.post(path, data, {
        ...options,
        headers: {
          ...this._getHeaders(),
          ...options.headers
        }
      });
    },

    /**
     * Make a PUT request
     * @param {string} path - Request path
     * @param {Object} data - Request body
     * @param {Object} options - Axios options
     * @returns {Promise<Object>} Response
     */
    async put(path, data = {}, options = {}) {
      return client.put(path, data, {
        ...options,
        headers: {
          ...this._getHeaders(),
          ...options.headers
        }
      });
    },

    /**
     * Make a DELETE request
     * @param {string} path - Request path
     * @param {Object} options - Axios options
     * @returns {Promise<Object>} Response
     */
    async delete(path, options = {}) {
      return client.delete(path, {
        ...options,
        headers: {
          ...this._getHeaders(),
          ...options.headers
        }
      });
    },

    /**
     * Get headers with auth token
     * @returns {Object} Headers
     */
    _getHeaders() {
      const headers = {
        'Content-Type': 'application/json'
      };

      if (this.token) {
        headers['Authorization'] = `Bearer ${this.token}`;
      }

      return headers;
    }
  };
};

/**
 * Test response expectations
 */
export const expectSuccess = (response, expectedData = null) => {
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);

  if (expectedData !== null) {
    expect(response.data).toMatchObject(expectedData);
  }
};

export const expectError = (response, expectedStatus = 400) => {
  expect(response.status).toBeGreaterThanOrEqual(expectedStatus);
  expect(response.status).toBeLessThan(500);
};

export const expectUnauthorized = (response) => {
  expect(response.status).toBe(401);
  expect(response.data).toHaveProperty('error');
};

export const expectNotFound = (response) => {
  expect(response.status).toBe(404);
};

/**
 * Common API endpoints for testing
 */
export const API_ENDPOINTS = {
  // User endpoints
  REGISTER: '/api/auth/register',
  LOGIN: '/api/auth/login',
  LOGOUT: '/api/auth/logout',
  VERIFY_EMAIL: '/api/auth/verify-email',
  FORGOT_PASSWORD: '/api/auth/forgot-password',
  RESET_PASSWORD: '/api/auth/reset-password',

  // Wallet endpoints
  GET_BALANCE: '/api/wallet/balance',
  GET_WALLET: '/api/wallet',
  DEPOSIT_ADDRESS: '/api/wallet/deposit-address',
  WITHDRAW: '/api/wallet/withdraw',
  TRANSFER: '/api/wallet/transfer',
  TRANSACTION_HISTORY: '/api/wallet/transactions',

  // Currency endpoints
  GET_CURRENCIES: '/api/currencies',
  GET_CURRENCY: '/api/currencies/:symbol',

  // Admin endpoints
  GET_ALL_USERS: '/api/admin/users',
  UPDATE_USER: '/api/admin/users/:id',
  GET_DEPOSITS: '/api/admin/deposits',
  APPROVE_WITHDRAW: '/api/admin/withdraw/:id/approve'
};
