/**
 * Seed Script - Currencies and Trading Pairs
 *
 * This script seeds:
 * 1. Currencies (only those with icons in cryptoicons folder)
 * 2. Spot Trading Pairs
 *
 * Usage: node scripts/seed-pairs.js
 *
 * Note: Only includes currencies that have icons in:
 *       /public/assets/images/cryptoicons/
 */

import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// MongoDB connections
const WALLET_DB = 'mongodb://127.0.0.1:27017/cryptodex_wallet';
const SPOT_DB = 'mongodb://127.0.0.1:27017/cryptodex_spot';

// ============================================
// GET AVAILABLE ICONS
// ============================================

const ICONS_DIR = '/Users/illy/Cryptodex/code/CRYPTODEXFINAL/cryptodex-frontend/public/assets/images/cryptoicons';
const WALLET_CURRENCY_DIR = '/Users/illy/Cryptodex/code/CRYPTODEXFINAL/cryptodex-walletapi/public/currency';

function getAvailableIcons() {
  const files = fs.readdirSync(ICONS_DIR);
  const icons = new Set();
  for (const file of files) {
    const name = path.basename(file, path.extname(file));
    icons.add(name);
  }
  return icons;
}

function getWalletCurrencyImages() {
  const files = fs.readdirSync(WALLET_CURRENCY_DIR);
  const images = new Set();
  for (const file of files) {
    images.add(file);
  }
  return images;
}

const availableIcons = getAvailableIcons();
const walletImages = getWalletCurrencyImages();
console.log(`Found ${availableIcons.size} cryptoicons, ${walletImages.size} wallet currency images`);

// ============================================
// DATA - Only currencies with available icons
// ============================================

const CURRENCIES = [
  // Icons available in cryptoicons folder
  // Image filenames match cryptoicons: btc.png, eth.png, solana.png, etc.
  { coin: 'BTC', symbol: 'BTC', name: 'Bitcoin', type: 'crypto', gateway_code: 'BTC', image: 'btc.png' },
  { coin: 'ETH', symbol: 'ETH', name: 'Ethereum', type: 'crypto', gateway_code: 'ETH', image: 'eth.png' },
  { coin: 'USDT', symbol: 'USDT', name: 'Tether', type: 'token', gateway_code: 'USDT', image: 'usdt.png', tokenType: 'erc20' },
  { coin: 'BNB', symbol: 'BNB', name: 'Binance Coin', type: 'crypto', gateway_code: 'BNB', image: 'bnb.png' },
  { coin: 'SOL', symbol: 'SOL', name: 'Solana', type: 'crypto', gateway_code: 'SOL', image: 'solana.png' },
  { coin: 'XRP', symbol: 'XRP', name: 'Ripple', type: 'crypto', gateway_code: 'XRP', image: 'xrp.png' },
  { coin: 'DOGE', symbol: 'DOGE', name: 'Dogecoin', type: 'crypto', gateway_code: 'DOGE', image: 'doge.png' },
  { coin: 'ADA', symbol: 'ADA', name: 'Cardano', type: 'crypto', gateway_code: 'ADA', image: 'ada.png' },
  { coin: 'DOT', symbol: 'DOT', name: 'Polkadot', type: 'crypto', gateway_code: 'DOT', image: 'dot.png' },
  { coin: 'LINK', symbol: 'LINK', name: 'Chainlink', type: 'token', gateway_code: 'LINK', image: 'link.png', tokenType: 'erc20' },
  { coin: 'ATOM', symbol: 'ATOM', name: 'Cosmos', type: 'crypto', gateway_code: 'ATOM', image: 'atom.png' },
  { coin: 'LTC', symbol: 'LTC', name: 'Litecoin', type: 'crypto', gateway_code: 'LTC', image: 'ltc.png' },
  { coin: 'BCH', symbol: 'BCH', name: 'Bitcoin Cash', type: 'crypto', gateway_code: 'BCH', image: 'bch.png' },
  { coin: 'FIL', symbol: 'FIL', name: 'Filecoin', type: 'crypto', gateway_code: 'FIL', image: 'fil.png' },
  { coin: 'UNI', symbol: 'UNI', name: 'Uniswap', type: 'token', gateway_code: 'UNI', image: 'uni.png', tokenType: 'erc20' },
  { coin: 'TRX', symbol: 'TRX', name: 'TRON', type: 'crypto', gateway_code: 'TRX', image: 'trx.png' },
  { coin: 'XTZ', symbol: 'XTZ', name: 'Tezos', type: 'crypto', gateway_code: 'XTZ', image: 'xtz.png' },
  { coin: 'EOS', symbol: 'EOS', name: 'EOS', type: 'crypto', gateway_code: 'EOS', image: 'eos.png' },
  { coin: 'ETC', symbol: 'ETC', name: 'Ethereum Classic', type: 'crypto', gateway_code: 'ETC', image: 'etc.png' },
  { coin: 'DASH', symbol: 'DASH', name: 'Dash', type: 'crypto', gateway_code: 'DASH', image: 'dash.png' },
];

// Filter to only include currencies with available icons
const VALID_CURRENCIES = CURRENCIES.filter(c => {
  // Check if icon exists in cryptoicons folder (source of truth)
  const iconName = path.basename(c.image, path.extname(c.image));
  const hasIcon = availableIcons.has(iconName);

  // Check if the expected wallet image exists
  const hasWalletImage = walletImages.has(c.image);

  if (!hasIcon) {
    console.log(`  ⚠️  Skipping ${c.coin} - no cryptoicon found for ${iconName}`);
  }
  if (!hasWalletImage) {
    console.log(`  ⚠️  Skipping ${c.coin} - no wallet image found for ${c.image}`);
  }

  return hasIcon && hasWalletImage;
});

console.log(`Using ${VALID_CURRENCIES.length} currencies with available icons`);

// Spot pairs: firstCurrency / secondCurrency
const SPOT_PAIRS = [
  { first: 'BTC', second: 'USDT', tikerRoot: 'BTCUSDT', price: 95000 },
  { first: 'ETH', second: 'USDT', tikerRoot: 'ETHUSDT', price: 3500 },
  { first: 'BNB', second: 'USDT', tikerRoot: 'BNBUSDT', price: 650 },
  { first: 'SOL', second: 'USDT', tikerRoot: 'SOLUSDT', price: 210 },
  { first: 'XRP', second: 'USDT', tikerRoot: 'XRPUSDT', price: 2.5 },
  { first: 'DOGE', second: 'USDT', tikerRoot: 'DOGEUSDT', price: 0.35 },
  { first: 'ADA', second: 'USDT', tikerRoot: 'ADAUSDT', price: 0.85 },
  { first: 'DOT', second: 'USDT', tikerRoot: 'DOTUSDT', price: 8.5 },
  { first: 'LINK', second: 'USDT', tikerRoot: 'LINKUSDT', price: 18 },
  { first: 'ATOM', second: 'USDT', tikerRoot: 'ATOMUSDT', price: 9.5 },
  { first: 'LTC', second: 'USDT', tikerRoot: 'LTCUSDT', price: 95 },
  { first: 'ETH', second: 'BTC', tikerRoot: 'ETHBTC', price: 0.037 },
  { first: 'SOL', second: 'BTC', tikerRoot: 'SOLBTC', price: 0.0022 },
  { first: 'BNB', second: 'BTC', tikerRoot: 'BNBBTC', price: 0.0068 },
  { first: 'TRX', second: 'USDT', tikerRoot: 'TRXUSDT', price: 0.25 },
  { first: 'XTZ', second: 'USDT', tikerRoot: 'XTZUSDT', price: 1.2 },
  { first: 'EOS', second: 'USDT', tikerRoot: 'EOSUSDT', price: 0.85 },
  { first: 'ETC', second: 'USDT', tikerRoot: 'ETCUSDT', price: 22 },
  { first: 'DASH', second: 'USDT', tikerRoot: 'DASHUSDT', price: 35 },
  { first: 'BCH', second: 'USDT', tikerRoot: 'BCHUSDT', price: 380 },
  { first: 'FIL', second: 'USDT', tikerRoot: 'FILUSDT', price: 7.5 },
  { first: 'UNI', second: 'USDT', tikerRoot: 'UNIUSDT', price: 14 },
];

// ============================================
// MODELS
// ============================================

const currencySchema = new mongoose.Schema({}, { strict: false });
const CurrencyModel = mongoose.model('currency', currencySchema, 'currency');

const spotPairSchema = new mongoose.Schema({}, { strict: false });
const SpotPairModel = mongoose.model('spotpair', spotPairSchema, 'spotpair');

// ============================================
// FUNCTIONS
// ============================================

async function clearExistingData() {
  console.log('\n=== Clearing existing data ===');

  const walletConn = await mongoose.createConnection(WALLET_DB).asPromise();
  const Currency = walletConn.model('currency', currencySchema, 'currency');
  await Currency.deleteMany({});
  console.log('  ✅ Cleared currencies');
  await walletConn.close();

  const spotConn = await mongoose.createConnection(SPOT_DB).asPromise();
  const SpotPair = spotConn.model('spotpair', spotPairSchema, 'spotpair');
  await SpotPair.deleteMany({});
  console.log('  ✅ Cleared spot pairs');
  await spotConn.close();
}

async function seedCurrencies() {
  console.log('\n=== Seeding Currencies ===');

  const walletConn = await mongoose.createConnection(WALLET_DB).asPromise();
  const Currency = walletConn.model('currency', currencySchema, 'currency');

  const created = [];
  for (const curr of VALID_CURRENCIES) {
    const doc = await Currency.create({
      ...curr,
      status: 'active',
      depositStatus: 'active',
      withdrawStatus: 'active',
      depositType: 'local',
      decimals: 18,
      contractDecimal: 18,
      withdrawFee: 0,
      minimumWithdraw: 0.001,
      maximumWithdraw: 1000000,
      minimumDeposit: 0.001,
      maximumDeposit: 10000000,
      block: 0,
    });
    created.push(doc);
    console.log(`  ✅ ${curr.coin} -> ${curr.image}`);
  }

  await walletConn.close();
  return created;
}

async function seedSpotPairs(currencies) {
  console.log('\n=== Seeding Spot Trading Pairs ===');

  const spotConn = await mongoose.createConnection(SPOT_DB).asPromise();
  const SpotPair = spotConn.model('spotpair', spotPairSchema, 'spotpair');

  const currencyMap = new Map(currencies.map(c => [c.coin, c._id]));
  const validCoins = new Set(currencies.map(c => c.coin));

  for (const pair of SPOT_PAIRS) {
    const firstCurrencyId = currencyMap.get(pair.first);
    const secondCurrencyId = currencyMap.get(pair.second);

    if (!firstCurrencyId || !secondCurrencyId) {
      console.log(`  ⚠️  Skipping ${pair.tikerRoot} - missing currency`);
      continue;
    }

    await SpotPair.create({
      tikerRoot: pair.tikerRoot,
      firstCurrencyId,
      firstCurrencySymbol: pair.first,
      firstFloatDigit: 8,
      secondCurrencyId,
      secondCurrencySymbol: pair.second,
      secondFloatDigit: 8,
      minPricePercentage: -10,
      maxPricePercentage: 10,
      maxQuantity: 10000,
      minQuantity: 0.00000001,
      maxOrderValue: 1000000,
      minOrderValue: 10,
      maker_rebate: 0.001,
      taker_fees: 0.001,
      last: pair.price,
      prevMarkPrice: pair.price,
      markPrice: pair.price,
      low: pair.price * 0.95,
      high: pair.price * 1.05,
      firstVolume: 1000,
      secondVolume: pair.price * 1000,
      changePrice: 0,
      change: 0,
      markupPercentage: 0,
      marketPercent: 50,
      botstatus: 'off',
      status: 'active',
      isSecondTradeFee: 'not_ignore',
      last_ask: pair.price * 1.001,
      last_bid: pair.price * 0.999,
    });
    console.log(`  ✅ ${pair.tikerRoot}`);
  }

  await spotConn.close();
}

async function main() {
  console.log('=================================================');
  console.log('  Cryptodex - Seed Currencies and Trading Pairs');
  console.log('  (Only using available crypto icons)');
  console.log('=================================================');

  try {
    // Clear existing data first
    await clearExistingData();

    // Seed currencies first (needed for pairs)
    const currencies = await seedCurrencies();

    // Seed all pair types
    await seedSpotPairs(currencies);

    console.log('\n=================================================');
    console.log('  ✅ Seeding Complete!');
    console.log('=================================================');
    console.log('\nSummary:');
    console.log(`  - Currencies: ${VALID_CURRENCIES.length}`);
    console.log(`  - Spot Pairs: ${SPOT_PAIRS.length}`);
    console.log('\nNext steps:');
    console.log('  1. Run the Redis load scripts:');
    console.log('     cd cryptodex-spotapi && node loadPairsToRedis.js');
    console.log('  2. Restart your services');
    console.log('');

  } catch (error) {
    console.error('\n❌ Error during seeding:', error);
    process.exit(1);
  }
}

main();
