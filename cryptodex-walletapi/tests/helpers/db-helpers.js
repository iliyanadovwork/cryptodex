/**
 * Database Test Helpers
 *
 * Utilities for setting up test data in MongoDB
 */

import mongoose from 'mongoose';

/**
 * Clean all collections in the test database
 * @returns {Promise<void>}
 */
export const cleanDatabase = async () => {
  const collections = await mongoose.connection.db.collections();
  for (const collection of collections) {
    await collection.deleteMany({});
  }
};

/**
 * Drop all collections in the test database
 * @returns {Promise<void>}
 */
export const dropDatabase = async () => {
  const collections = await mongoose.connection.db.collections();
  for (const collection of collections) {
    await collection.deleteMany({});
  }
};

/**
 * Get a collection by name
 * @param {string} name - Collection name
 * @returns {Collection} MongoDB collection
 */
export const getCollection = (name) => {
  return mongoose.connection.db.collection(name);
};

/**
 * Insert test data into a collection
 * @param {string} collectionName - Name of collection
 * @param {Array|Object} data - Data to insert
 * @returns {Promise<void>}
 */
export const insertTestData = async (collectionName, data) => {
  const collection = getCollection(collectionName);
  const docs = Array.isArray(data) ? data : [data];
  await collection.insertMany(docs);
};

/**
 * Count documents in a collection
 * @param {string} collectionName - Name of collection
 * @param {Object} query - Query filter
 * @returns {Promise<number>} Document count
 */
export const countDocuments = async (collectionName, query = {}) => {
  const collection = getCollection(collectionName);
  return collection.countDocuments(query);
};

/**
 * Find a document in a collection
 * @param {string} collectionName - Name of collection
 * @param {Object} query - Query filter
 * @returns {Promise<Object|null>} Found document
 */
export const findOne = async (collectionName, query = {}) => {
  const collection = getCollection(collectionName);
  return collection.findOne(query);
};

/**
 * Find all documents in a collection
 * @param {string} collectionName - Name of collection
 * @param {Object} query - Query filter
 * @returns {Promise<Array>} Found documents
 */
export const findMany = async (collectionName, query = {}) => {
  const collection = getCollection(collectionName);
  return collection.find(query).toArray();
};

/**
 * Create a test user in the database
 * @param {Object} userData - User data
 * @returns {Promise<Object>} Created user
 */
export const createTestUser = async (userData) => {
  const collection = getCollection('user');
  const result = await collection.insertOne(userData);
  return { ...userData, _id: result.insertedId };
};

/**
 * Create a test wallet in the database
 * @param {Object} walletData - Wallet data
 * @returns {Promise<Object>} Created wallet
 */
export const createTestWallet = async (walletData) => {
  const collection = getCollection('wallet');
  const result = await collection.insertOne(walletData);
  return { ...walletData, _id: result.insertedId };
};

/**
 * Create a test currency in the database
 * @param {Object} currencyData - Currency data
 * @returns {Promise<Object>} Created currency
 */
export const createTestCurrency = async (currencyData) => {
  const collection = getCollection('currency');
  const result = await collection.insertOne(currencyData);
  return { ...currencyData, _id: result.insertedId };
};

/**
 * Helper to setup test database state
 * @param {Object} fixtures - Fixture data to insert
 * @returns {Promise<void>}
 */
export const setupFixtures = async (fixtures = {}) => {
  const {
    users = [],
    wallets = [],
    currencies = [],
    transactions = []
  } = fixtures;

  if (users.length > 0) {
    await insertTestData('user', users);
  }
  if (wallets.length > 0) {
    await insertTestData('wallet', wallets);
  }
  if (currencies.length > 0) {
    await insertTestData('currency', currencies);
  }
  if (transactions.length > 0) {
    await insertTestData('transaction', transactions);
  }
};
