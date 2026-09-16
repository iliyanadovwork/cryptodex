// Script to add BTC currency to database
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

// Currencies to add
const currencies = [
  {
    name: 'Bitcoin',
    coin: 'BTC',
    symbol: 'BTC',
    type: 'crypto',
    withdrawFee: 0.001,
    minimumWithdraw: 0.0001,
    maximumWithdraw: 10,
    minimumDeposit: 0.0001,
    maximumDeposit: 100,
    decimals: 8,
    contractDecimal: 8,
    image: 'bitcoin.png', // You can replace with actual image
    status: 'active',
    depositType: 'local',
    depositStatus: 'active',
    withdrawStatus: 'active',
    isTradeFee: 'not_ignore',
  },
  {
    name: 'Ethereum',
    coin: 'ETH',
    symbol: 'ETH',
    type: 'crypto',
    withdrawFee: 0.01,
    minimumWithdraw: 0.001,
    maximumWithdraw: 100,
    minimumDeposit: 0.001,
    maximumDeposit: 1000,
    decimals: 18,
    contractDecimal: 18,
    image: 'ethereum.png',
    status: 'active',
    depositType: 'local',
    depositStatus: 'active',
    withdrawStatus: 'active',
    isTradeFee: 'not_ignore',
  },
  {
    name: 'Tether',
    coin: 'USDT',
    symbol: 'USDT',
    type: 'token',
    tokenType: 'ERC20',
    withdrawFee: 5,
    minimumWithdraw: 1,
    maximumWithdraw: 10000,
    minimumDeposit: 1,
    maximumDeposit: 50000,
    decimals: 6,
    contractDecimal: 6,
    image: 'tether.png',
    status: 'active',
    depositType: 'local',
    depositStatus: 'active',
    withdrawStatus: 'active',
    isTradeFee: 'not_ignore',
    contractAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7', // Mainnet USDT (example)
  },
];

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

console.log('\nDone! Currencies added to cryptodex_wallet database.');
await mongoose.disconnect();
