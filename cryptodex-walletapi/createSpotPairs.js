// Script to create spot pairs
import mongoose from 'mongoose';

// Connect to MongoDB - need to connect to both databases
const walletConn = await mongoose.createConnection('mongodb://127.0.0.1:27017/cryptodex_wallet');
const spotConn = await mongoose.createConnection('mongodb://127.0.0.1:27017/cryptodex_spot');

// Define Currency schema
const CurrencySchema = new mongoose.Schema({
  _id: mongoose.Schema.Types.ObjectId,
  name: String,
  coin: String,
  symbol: String,
}, { collection: 'currency', versionKey: false });

const Currency = walletConn.model('currency', CurrencySchema);

// Define SpotPair schema
const SpotPairSchema = new mongoose.Schema({
  tikerRoot: String,
  firstCurrencyId: mongoose.Schema.Types.ObjectId,
  firstCurrencySymbol: String,
  firstFloatDigit: Number,
  secondCurrencyId: mongoose.Schema.Types.ObjectId,
  secondCurrencySymbol: String,
  secondFloatDigit: Number,
  minPricePercentage: Number,
  maxPricePercentage: Number,
  minQuantity: Number,
  maxQuantity: Number,
  minOrderValue: Number,
  maxOrderValue: Number,
  maker_rebate: Number,
  taker_fees: Number,
  markPrice: Number,
  markupPercentage: Number,
  botstatus: String,
  marketPercent: Number,
  status: String,
}, { collection: 'spotpair', versionKey: false });

const SpotPair = spotConn.model('spotpair', SpotPairSchema);

// Get currency IDs
console.log('Fetching currency IDs...');
const currencies = await Currency.find({ coin: { $in: ['BTC', 'ETH', 'BNB', 'SOL', 'TRX', 'DOGE', 'USDT'] } });

const currencyMap = {};
currencies.forEach(c => {
  currencyMap[c.coin] = c._id;
  console.log(`Found: ${c.coin} -> ${c._id}`);
});

if (!currencyMap.USDT) {
  console.error('USDT not found! Cannot create pairs.');
  process.exit(1);
}

// Define pairs to create
const pairs = [
  { first: 'BTC', second: 'USDT', markPrice: 95000 },
  { first: 'ETH', second: 'USDT', markPrice: 3500 },
  { first: 'BNB', second: 'USDT', markPrice: 650 },
  { first: 'SOL', second: 'USDT', markPrice: 150 },
  { first: 'TRX', second: 'USDT', markPrice: 0.25 },
  { first: 'DOGE', second: 'USDT', markPrice: 0.35 },
];

console.log('\nCreating spot pairs...');

for (const pair of pairs) {
  const firstId = currencyMap[pair.first];
  const secondId = currencyMap[pair.second];

  if (!firstId) {
    console.log(`⚠️  Skipping ${pair.first}/${pair.second} - ${pair.first} not found`);
    continue;
  }

  // Check if pair already exists
  const existing = await SpotPair.findOne({
    firstCurrencyId: firstId,
    secondCurrencyId: secondId
  });

  if (existing) {
    console.log(`⚠️  Pair ${pair.first}/${pair.second} already exists, skipping...`);
    continue;
  }

  const newPair = new SpotPair({
    tikerRoot: `${pair.first}${pair.second}`,
    firstCurrencyId: firstId,
    firstCurrencySymbol: pair.first,
    firstFloatDigit: 8,
    secondCurrencyId: secondId,
    secondCurrencySymbol: pair.second,
    secondFloatDigit: 6,
    minPricePercentage: 0.1,
    maxPricePercentage: 10,
    minQuantity: 0.0001,
    maxQuantity: 10000,
    minOrderValue: 10,
    maxOrderValue: 100000,
    maker_rebate: 0.001,
    taker_fees: 0.002,
    markPrice: pair.markPrice,
    markupPercentage: 0.5,
    botstatus: 'off',
    marketPercent: 0,
    status: 'active',
  });

  await newPair.save();
  console.log(`✅ Created ${pair.first}/${pair.second} pair`);
}

console.log('\nDone! All spot pairs created.');

await walletConn.close();
await spotConn.close();
