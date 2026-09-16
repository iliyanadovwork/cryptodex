// Script to create wallet for existing users
import mongoose from 'mongoose';
import { emptyAsset } from './controllers/createAsset.js';
import config from './config/index.js';

// Connect to MongoDB
await mongoose.connect(config.DATABASE_URI);

// Get all users from the user database
const userDb = mongoose.connection.useDb('cryptodex_user');
const users = await userDb.collection('user').find({}).limit(10).toArray();

console.log(`Found ${users.length} users. Creating wallets...`);

// Create wallet for each user
for (const user of users) {
  console.log(`Creating wallet for user: ${user.email} (${user._id})`);

  try {
    await emptyAsset({
      userId: user._id.toString(),
      userCode: user.userId || '',
      botUser: false
    });
    console.log(`✅ Wallet created for ${user.email}`);
  } catch (err) {
    console.log(`❌ Error creating wallet for ${user.email}:`, err.message);
  }
}

await mongoose.disconnect();
console.log('Done!');
