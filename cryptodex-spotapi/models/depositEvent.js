// DepositEvent Model
//
// WAS a log of Solana deposit webhooks. This venue holds no custody and takes
// no deposits, and the only writer left is the faucet - so what this records
// now is demo credits, one row per coin per claim.
//
// The blockchain shape it inherited is being unwound. The chain field went
// first: it was required and permitted exactly one value, so every faucet claim
// was stamped with a chain this venue does not use and a currency that has been
// deleted. Its indexes went with it - see the note on them below.

import mongoose from 'mongoose';

const depositEventSchema = new mongoose.Schema({
  signature: {
    type: String,
    required: true // the faucet's own reference for the claim
  },
  fromAddress: {
    type: String
  },
  toAddress: {
    type: String,
    required: true,
    index: true
  },
  asset: {
    type: String,
    required: true
  },
  /**
   * WHICH WALLET THE CREDIT LANDED IN.
   *
   * A faucet claim could credit MORE THAN ONE wallet, and until this column
   * existed only the spot half could be recorded, because a row had no way to
   * say it was anything else. The user's own history was therefore missing
   * money they had been given, and the UI had to reconstruct the rest from a
   * client-side receipt that only existed on the device that made the claim.
   *
   * Not an enum: the wallet names come from the faucet's own credit list, and a
   * row must be able to record a wallet this model has not been taught about
   * rather than fail to save. Rows written before this column default to 'spot',
   * which is what every one of them was.
   */
  wallet: {
    type: String,
    default: 'spot',
    index: true
  },
  amount: {
    type: String,
    required: true // Use string for precision
  },
  decimals: {
    type: Number
  },
  tokenContract: {
    type: String // SPL token mint address
  },
  slot: {
    type: Number // Solana slot
  },
  confirmations: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['seen', 'pending', 'credited', 'ignored', 'refunded'],
    default: 'seen'
  },
  creditedAt: {
    type: Date
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  errorMsg: {
    type: String
  },
  rawPayload: {
    type: mongoose.Schema.Types.Mixed // Store original webhook payload
  }
}, {
  timestamps: true
});

/*
 * INDEXED FOR THE QUERY THAT HAPPENS.
 *
 * Two of the three indexes here covered fields nothing reads. One led on the
 * chain field, now gone, and carried `confirmations` - a count of block
 * confirmations, on a venue with no blocks. The other led on `toAddress`, which
 * the faucet writes as the constant "faucet", so it distinguished no two rows.
 *
 * Meanwhile the ONE query this collection actually serves -
 * deposit.controller's `{ userId, status: 'credited' }`, for both the count and
 * the page - had no index at all and scanned.
 *
 * The unique index on `signature` stays: it is what makes a claim idempotent,
 * and the faucet builds that signature per user, per wallet, per coin, per
 * timestamp precisely so a repeat cannot double-credit.
 */
depositEventSchema.index({ signature: 1 }, { unique: true });
depositEventSchema.index({ userId: 1, status: 1 });

export default mongoose.model('DepositEvent', depositEventSchema);
