// Script to add more currencies and create spot pairs
import mongoose from 'mongoose';

// Connect to MongoDB
await mongoose.connect('mongodb://127.0.0.1:27017/cryptodex_wallet');

// Define the Currency schema
const CurrencySchema = new mongoose.Schema({
  name: String,
  coin: String,
  symbol: String,
  type: String,
  withdrawFee: Number,
  minimumWithdraw: Number,
  maximumWithdraw: Number,
  minimumDeposit: Number,
  maximumDeposit: Number,
  decimals: Number,
  contractDecimal: Number,
  image: String,
  status: String,
  depositType: String,
  tokenType: String,
  depositStatus: String,
  withdrawStatus: String,
  isTradeFee: String,
}, { collection: 'currency' });

const Currency = mongoose.model('currency', CurrencySchema);

// Additional currencies needed
const currencies = [
  {
    name: 'Binance Coin',
    coin: 'BNB',
    symbol: 'BNB',
    type: 'crypto',
    withdrawFee: 0.01,
    minimumWithdraw: 0.001,
    maximumWithdraw: 100,
    minimumDeposit: 0.001,
    maximumDeposit: 1000,
    decimals: 18,
    contractDecimal: 18,
    image: 'bnb.png',
    status: 'active',
    depositType: 'local',
    depositStatus: 'active',
    withdrawStatus: 'active',
    isTradeFee: 'not_ignore',
  },
  {
    name: 'Solana',
    coin: 'SOL',
    symbol: 'SOL',
    type: 'crypto',
    withdrawFee: 0.01,
    minimumWithdraw: 0.01,
    maximumWithdraw: 1000,
    minimumDeposit: 0.01,
    maximumDeposit: 10000,
    decimals: 9,
    contractDecimal: 9,
    image: 'solana.png',
    status: 'active',
    depositType: 'local',
    depositStatus: 'active',
    withdrawStatus: 'active',
    isTradeFee: 'not_ignore',
  },
  {
    name: 'TRON',
    coin: 'TRX',
    symbol: 'TRX',
    type: 'crypto',
    withdrawFee: 1,
    minimumWithdraw: 1,
    maximumWithdraw: 100000,
    minimumDeposit: 1,
    maximumDeposit: 1000000,
    decimals: 6,
    contractDecimal: 6,
    image: 'tron.png',
    status: 'active',
    depositType: 'local',
    depositStatus: 'active',
    withdrawStatus: 'active',
    isTradeFee: 'not_ignore',
  },
  {
    name: 'Dogecoin',
    coin: 'DOGE',
    symbol: 'DOGE',
    type: 'crypto',
    withdrawFee: 1,
    minimumWithdraw: 1,
    maximumWithdraw: 100000,
    minimumDeposit: 1,
    maximumDeposit: 1000000,
    decimals: 8,
    contractDecimal: 8,
    image: 'dogecoin.png',
    status: 'active',
    depositType: 'local',
    depositStatus: 'active',
    withdrawStatus: 'active',
    isTradeFee: 'not_ignore',
  },
];

console.log('Adding currencies...');
for (const currency of currencies) {
  const existing = await Currency.findOne({ coin: currency.coin });
  if (existing) {
    console.log(`⚠️  ${currency.coin} already exists, skipping...`);
  } else {
    const newCurrency = new Currency(currency);
    await newCurrency.save();
    console.log(`✅ Added ${currency.coin} - ${currency.name}`);
  }
}

console.log('\nAll currencies added!');
await mongoose.disconnect();
