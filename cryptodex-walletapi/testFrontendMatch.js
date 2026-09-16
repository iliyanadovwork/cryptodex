// Test exact frontend matching logic
import mongoose from 'mongoose';

const conn = await mongoose.createConnection('mongodb://127.0.0.1:27017/cryptodex_wallet').asPromise();

// Get wallet assets exactly as API returns them
const wallet = await conn.collection('wallet').findOne(
  { _id: new mongoose.Types.ObjectId('69553dca53d07f6e475cb1b6') },
  {
    "assets._id": 1,
    "assets.coin": 1,
    "assets.currencyId": 1,
    "assets.address": 1,
    "assets.spotBal": 1,
  }
);

// Get currencies
const currencies = await conn.collection('currency').find({
  coin: { $in: ['BTC', 'ETH', 'USDT'] }
}).toArray();

console.log('=== Assets from wallet ===');
console.log(JSON.stringify(wallet.assets, null, 2));

console.log('\n=== Currencies ===');
console.log(JSON.stringify(currencies.map(c => ({ _id: c._id, coin: c.coin, type: c.type, status: c.status })), null, 2));

// Test the OLD matching logic (el._id == item._id) - WRONG
console.log('\n=== OLD LOGIC (el._id == item._id) ===');
let tempArr1 = [...wallet.assets];
currencies.forEach((item) => {
  let pairIndex = tempArr1.findIndex((el) => {
    return el._id == item._id;
  });
  console.log(`Looking for ${item.coin} (_id=${item._id}): found at index ${pairIndex}`);
});
console.log('Assets matched:', tempArr1.filter(a => a.image).length);

// Test the NEW matching logic (el.currencyId == item._id) - CORRECT
console.log('\n=== NEW LOGIC (el.currencyId == item._id) ===');
let tempArr2 = [...wallet.assets];
currencies.forEach((item) => {
  let pairIndex = tempArr2.findIndex((el) => {
    const currencyIdStr = el.currencyId?.toString() || el.currencyId;
    const itemIdStr = item._id?.toString() || item._id;
    return currencyIdStr == itemIdStr || el.coin == item.coin;
  });
  if (pairIndex >= 0) {
    const asset = tempArr2[pairIndex];
    console.log(`✓ Matched ${item.coin}: currencyId=${asset.currencyId} == _id=${item._id}`);
    let btnStatus = "deActive";
    if (item.type == "crypto" && item.status == "active") {
      btnStatus = "active";
    } else if (item.type == "token") {
      if (asset.tokenAddressArray && asset.tokenAddressArray.length > 0) {
        // check token array
      } else if (item.status == "active") {
        btnStatus = "active";
      }
    }
    tempArr2[pairIndex] = { ...tempArr2[pairIndex], btnStatus };
    console.log(`  -> btnStatus = ${btnStatus}`);
  }
});
console.log('Assets with btnStatus=active:', tempArr2.filter(a => a.btnStatus == "active").length);

await conn.close();
