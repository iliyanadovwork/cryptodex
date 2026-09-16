// Currency Model
// Connects to the wallet database to access currency data

import mongoose from 'mongoose';

// Create connection to wallet database
const walletDb = mongoose.createConnection(
  process.env.WALLET_DB_URL || 'mongodb://localhost:27017/cryptodex_wallet',
  {
    serverSelectionTimeoutMS: 5000
  }
);

const currencySchema = new mongoose.Schema({
  coin: {
    type: String,
    required: true,
    unique: true
  },
  name: String,
  type: String,
  status: String,
  network: String
}, {
  timestamps: true
});

const Currency = walletDb.model('currency', currencySchema, 'currency');

/**
 * The second mongoose connection itself, so the health probe can report its
 * readyState. It is deliberately a SOFT dependency: this connection only backs
 * currency metadata lookups, and its fallback URL is localhost, which on a
 * deployed host resolves to nothing - so a venue with WALLET_DB_URL unset
 * should read as "degraded" and say why, not as "up" and be silently wrong.
 */
export { walletDb };

export default Currency;
