// Test the updated matching logic
import mongoose from 'mongoose';

const conn = await mongoose.createConnection('mongodb://127.0.0.1:27017/cryptodex_wallet').asPromise();

// Get wallet assets
const wallet = await conn.collection('wallet').findOne(
  { _id: new mongoose.Types.ObjectId('69553dca53d07f6e475cb1b6') },
  { "assets._id": 1, "assets.coin": 1, "assets.currencyId": 1, "assets.tokenAddressArray": 1 }
);

// Get currencies
const currencies = await conn.collection('currency').find({
  coin: { $in: ['BTC', 'ETH', 'USDT'] }
}).toArray();

// Simulate the UPDATED matching logic
let tempArr = [...wallet.assets];

currencies.forEach((item) => {
  let pairIndex = tempArr.findIndex((el) => {
    const currencyIdStr = el.currencyId?.toString() || el.currencyId;
    const itemIdStr = item._id?.toString() || item._id;
    return currencyIdStr == itemIdStr || el.coin == item.coin;
  });

  if (pairIndex >= 0) {
    let btnStatus = "deActive";
    if (item.type == "crypto" && item.status == "active") {
      btnStatus = "active";
    } else if (item.type == "token") {
      // UPDATED LOGIC
      if (tempArr[pairIndex].tokenAddressArray && tempArr[pairIndex].tokenAddressArray.length > 0) {
        tempArr[pairIndex].tokenAddressArray.map((el) => {
          let currDoc = currencies.find((e) => {
            return e._id == el.currencyId;
          });
          if (currDoc?.status == "active") {
            btnStatus = "active";
          }
        });
      } else if (item.status == "active") {
        // Token with empty tokenAddressArray - still active if currency is active
        btnStatus = "active";
      }
    }

    tempArr[pairIndex] = {
      ...tempArr[pairIndex],
      image: item.image,
      minDeposit: item.minimumDeposit,
      type: item.type,
      btnStatus,
    };
  }
});

console.log('=== Final result ===');
tempArr.forEach(a => {
  console.log(`${a.coin}: btnStatus = ${a.btnStatus}`);
});

const activeAssets = tempArr.filter(item => item.btnStatus == "active");
console.log(`\nActive assets: ${activeAssets.length}`);

await conn.close();
