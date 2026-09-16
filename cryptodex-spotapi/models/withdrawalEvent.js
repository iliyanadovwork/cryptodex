// WithdrawalEvent Model
// Tracks all USDC withdrawal events

import mongoose from 'mongoose';

const withdrawalEventSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  amount: {
    type: String,
    required: true // Use string for precision (smallest units)
  },
  amountFormatted: {
    type: String, // Human-readable amount (e.g., "0.01")
    required: true
  },
  destinationAddress: {
    type: String,
    required: true
  },
  signature: {
    type: String,
    index: true // Solana transaction signature
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed'],
    default: 'pending'
  },
  errorMessage: {
    type: String
  },
  network: {
    // PAPER TRADING: every withdrawal this exchange issues is a paper txid, so
    // that is the default. It used to be 'devnet', which meant a row written
    // without an explicit network was born labelled as a chain transfer and
    // would be reported to the user as a pre-conversion "legacy" record - see
    // the PRE-CONVERSION WITHDRAWAL ROWS note in controllers/withdrawal.controller.js.
    // Rows that really are pre-conversion keep their stored 'devnet' value.
    type: String,
    default: 'paper'
  }
}, {
  timestamps: true
});

// Index for efficient queries
withdrawalEventSchema.index({ userId: 1, createdAt: -1 });
withdrawalEventSchema.index({ signature: 1 }, { unique: true, sparse: true });

export default mongoose.model('WithdrawalEvent', withdrawalEventSchema);
