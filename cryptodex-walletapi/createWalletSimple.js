// Simple script to create wallet for existing users
import mongoose from 'mongoose';

// Connect to MongoDB
await mongoose.connect('mongodb://localhost:27017/cryptodex_wallet');

// Get users from the user database
const userDb = mongoose.connection.useDb('cryptodex_user');
const users = await userDb.collection('user').find({}).toArray();

console.log(`Found ${users.length} users. Creating wallets...`);

// Wallet schema (simplified)
const walletSchema = new mongoose.Schema({
  _id: String,
  userCode: String,
  binSubAcctId: { type: String, default: '' },
  assets: Array,
}, { timestamps: true });

const Wallet = mongoose.model('wallet', walletSchema, 'wallet');

// Get currencies from wallet database
const currencies = await mongoose.connection.db.collection('currency').find({}).toArray();

console.log(`Found ${currencies.length} currencies`);

// Create wallet for each user
for (const user of users) {
  console.log(`Creating wallet for user: ${user.email} (${user._id})`);

  try {
    // Check if wallet already exists
    const existing = await Wallet.findById(user._id.toString());
    if (existing) {
      console.log(`  ⏭️  Wallet already exists, skipping`);
      continue;
    }

    // Create basic wallet with assets for each currency
    const assets = currencies.map(curr => ({
      _id: curr._id,
      coin: curr.coin || curr.symbol,
      address: '',
      destTag: '',
      spotBal: 0,
      p2pBal: 0,
      spotLockedBal: 0
    }));

    await Wallet.create({
      _id: user._id.toString(),
      userCode: user.userId || user._id.toString(),
      assets: assets
    });

    console.log(`  ✅ Wallet created with ${assets.length} assets`);
  } catch (err) {
    console.log(`  ❌ Error:`, err.message);
  }
}

await mongoose.disconnect();
console.log('Done!');
