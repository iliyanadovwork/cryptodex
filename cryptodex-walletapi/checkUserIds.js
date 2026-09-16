// Check user IDs across databases
import mongoose from 'mongoose';

// Connect to user database
const userConn = await mongoose.createConnection('mongodb://127.0.0.1:27017/cryptodex_user').asPromise();
const walletConn = await mongoose.createConnection('mongodb://127.0.0.1:27017/cryptodex_wallet').asPromise();

// Find test user in user database
const testUser = await userConn.collection('users').findOne({ email: 'test@cryptodex.com' });
console.log('User in cryptodex_user database:');
console.log('  _id:', testUser?._id);
console.log('  email:', testUser?.email);
console.log('  firstName:', testUser?.firstName);

// Find wallet in wallet database
const wallet = await walletConn.collection('wallet').findOne({ _id: new mongoose.Types.ObjectId('69553dca53d07f6e475cb1b6') });
console.log('\nWallet in cryptodex_wallet database:');
console.log('  _id:', wallet?._id);
console.log('  assets:', wallet?.assets?.map(a => a.coin));

// If user exists and IDs don't match, we need to fix it
if (testUser && testUser._id.toString() !== '69553dca53d07f6e475cb1b6') {
  console.log('\n⚠️  User ID mismatch!');
  console.log('  User _id:', testUser._id.toString());
  console.log('  Wallet _id:', '69553dca53d07f6e475cb1b6');
  console.log('\nNeed to create wallet with correct user ID:', testUser._id.toString());
}

await userConn.close();
await walletConn.close();
