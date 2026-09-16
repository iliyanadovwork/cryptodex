// Create test user with assets for deposit testing
import mongoose from 'mongoose';

const conn = await mongoose.createConnection('mongodb://127.0.0.1:27017/cryptodex_wallet').asPromise();

// Get currency IDs
const currencies = await conn.collection('currency').find({ coin: { $in: ['BTC', 'ETH', 'USDT'] } }).toArray();
console.log('Found currencies:', currencies.map(c => c.coin + ':' + c._id));

// Create test user
const userId = new mongoose.Types.ObjectId('69553dca53d07f6e475cb1b6');
const user = {
  _id: userId,
  email: 'test@cryptodex.com',
  firstName: 'Test',
  lastName: 'User',
  status: 'active',
  createdAt: new Date()
};

const existingUser = await conn.collection('users').findOne({ _id: userId });
if (!existingUser) {
  await conn.collection('users').insertOne(user);
  console.log('\n✅ Created test user:', userId);
} else {
  console.log('\nℹ️  User already exists');
}

// Create assets for this user
for (const currency of currencies) {
  const existingAsset = await conn.collection('assets').findOne({ userId: userId, currencyId: currency._id });
  if (!existingAsset) {
    const asset = {
      userId: userId,
      currencyId: currency._id,
      coin: currency.coin,
      spotBal: 0,
      spotInOrder: 0,
      binaryBal: 0,
      createdAt: new Date()
    };
    await conn.collection('assets').insertOne(asset);
    console.log('✅ Created asset for', currency.coin);
  } else {
    console.log('ℹ️  Asset for', currency.coin, 'already exists');
  }
}

// Create wallet entry
const existingWallet = await conn.collection('wallet').findOne({ userId: userId });
if (!existingWallet) {
  const wallet = {
    userId: userId,
    spotBal: 0,
    createdAt: new Date()
  };
  await conn.collection('wallet').insertOne(wallet);
  console.log('✅ Created wallet entry');
}

console.log('\nDone! Refresh the deposit page to see assets.');

await conn.close();
