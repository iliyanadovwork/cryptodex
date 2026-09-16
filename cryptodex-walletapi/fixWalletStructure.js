// Fix wallet document structure - _id should be userId
import mongoose from 'mongoose';

const conn = await mongoose.createConnection('mongodb://127.0.0.1:27017/cryptodex_wallet').asPromise();

const userId = new mongoose.Types.ObjectId('69553dca53d07f6e475cb1b6');

// Get currencies
const currencies = await conn.collection('currency').find({ coin: { $in: ['BTC', 'ETH', 'USDT'] } }).toArray();

// Build assets array
const assets = currencies.map(currency => ({
  _id: new mongoose.Types.ObjectId(),
  coin: currency.coin,
  currencyId: currency._id,
  address: '',
  destTag: '',
  spotBal: 0,
  spotInOrder: 0,
  spotLockedBal: 0,
  p2pBal: 0,
  tokenAddressArray: []
}));

console.log('Assets to embed:', assets.map(a => a.coin));

// Delete any existing wallets with this _id or userId
await conn.collection('wallet').deleteOne({ _id: userId });
await conn.collection('wallet').deleteOne({ userId: userId });
console.log('Deleted any existing wallets');

const newWallet = {
  _id: userId,
  binSubAcctId: null,
  assets: assets,
  createdAt: new Date(),
  updatedAt: new Date()
};

await conn.collection('wallet').insertOne(newWallet);
console.log('\nCreated new wallet with _id = userId');

// Verify
const wallet = await conn.collection('wallet').findOne({ _id: userId });
console.log('Wallet _id:', wallet._id);
console.log('Wallet assets count:', wallet?.assets?.length);
console.log('Assets:', wallet?.assets?.map(a => a.coin));

await conn.close();
console.log('\nDone!');
