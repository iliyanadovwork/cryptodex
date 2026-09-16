// Test the asset/currency matching logic
import mongoose from 'mongoose';

const conn = await mongoose.createConnection('mongodb://127.0.0.1:27017/cryptodex_wallet').asPromise();

// Get wallet assets (simulating API response)
const wallet = await conn.collection('wallet').findOne(
  { _id: new mongoose.Types.ObjectId('69553dca53d07f6e475cb1b6') },
  {
    "assets._id": 1,
    "assets.coin": 1,
    "assets.currencyId": 1,
    "assets.address": 1,
    "assets.destTag": 1,
    "assets.spotBal": 1,
  }
);

console.log('=== Wallet assets ===');
console.log(JSON.stringify(wallet.assets, null, 2));

// Get currencies
const currencies = await conn.collection('currency').find({
  coin: { $in: ['BTC', 'ETH', 'USDT'] }
}).toArray();

console.log('\n=== Currencies ===');
console.log(JSON.stringify(currencies, null, 2));

// Simulate the matching logic from frontend
console.log('\n=== Testing matching logic ===');
let tempArr = [...wallet.assets];
let matchCount = 0;

currencies.forEach((item) => {
  let pairIndex = tempArr.findIndex((el) => {
    const currencyIdStr = el.currencyId?.toString() || el.currencyId;
    const itemIdStr = item._id?.toString() || item._id;
    const match = currencyIdStr == itemIdStr || el.coin == item.coin;
    if (match) {
      console.log(`✓ Matched: ${el.coin} with ${item.coin}`);
      console.log(`  currencyId: ${currencyIdStr} == ${itemIdStr}`);
      matchCount++;
    }
    return match;
  });

  if (pairIndex >= 0) {
    let btnStatus = "deActive";
    if (item.type == "crypto" && item.status == "active") {
      btnStatus = "active";
    }
    tempArr[pairIndex] = {
      ...tempArr[pairIndex],
      image: item.image,
      minDeposit: item.minimumDeposit,
      type: item.type,
      btnStatus,
    };
    console.log(`  -> Updated with btnStatus: ${btnStatus}`);
  }
});

console.log(`\n=== Result: ${matchCount} matches ===`);
console.log('Final tempArr:', tempArr.map(a => ({ coin: a.coin, btnStatus: a.btnStatus })));

await conn.close();
