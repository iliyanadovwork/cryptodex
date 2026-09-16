// Update wallet document to include embedded assets
import mongoose from 'mongoose';

const conn = await mongoose.createConnection('mongodb://127.0.0.1:27017/cryptodex_wallet').asPromise();

const userId = new mongoose.Types.ObjectId('69553dca53d07f6e475cb1b6');

// Get currencies
const currencies = await conn.collection('currency').find({ coin: { $in: ['BTC', 'ETH', 'USDT'] } }).toArray();
console.log('Found currencies:', currencies.map(c => c.coin + ':' + c._id));

// Build assets array
const assets = currencies.map(currency => ({
  _id: new mongoose.Types.ObjectId(),
  coin: currency.coin,
  currencyId: currency._id,
  address: '',
  destTag: '',
  spotBal: 0,
  spotInOrder: 0,
  binaryBal: 0
}));

console.log('\nAssets to embed:', assets);

// Update wallet document with embedded assets
const result = await conn.collection('wallet').updateOne(
  { userId: userId },
  {
    $set: {
      assets: assets,
      updatedAt: new Date()
    }
  }
);

console.log('\nUpdate result:', result);

// Verify the update
const wallet = await conn.collection('wallet').findOne({ userId: userId });
console.log('\nWallet document now has', wallet?.assets?.length || 0, 'embedded assets');
if (wallet?.assets) {
  console.log('Assets:', wallet.assets.map(a => a.coin));
}

await conn.close();
console.log('\nDone!');
