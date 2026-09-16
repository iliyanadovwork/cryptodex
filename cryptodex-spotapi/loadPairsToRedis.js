// Load spot pairs from MongoDB to Redis
import mongoose from 'mongoose';
import redis from "redis";
import { promisify } from "util";

// Connect to both databases
const walletConn = await mongoose.createConnection('mongodb://127.0.0.1:27017/cryptodex_wallet');
const spotConn = await mongoose.createConnection('mongodb://127.0.0.1:27017/cryptodex_spot');

// Define Currency schema (for images)
const CurrencySchema = new mongoose.Schema({
  _id: mongoose.Schema.Types.ObjectId,
  image: String,
}, { collection: 'currency', versionKey: false });

const Currency = walletConn.model('currency', CurrencySchema);

// Define SpotPair schema
const SpotPairSchema = new mongoose.Schema({
  _id: mongoose.Schema.Types.ObjectId,
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

// Connect to Redis
const redisClient = redis.createClient({ url: 'redis://localhost:6379' });
redisClient.hset = promisify(redisClient.hset);

await new Promise((resolve) => {
  redisClient.on('connect', () => {
    console.log('Connected to Redis');
    resolve();
  });
  redisClient.on('error', (err) => {
    console.log('Redis error:', err);
    resolve();
  });
});

console.log('Fetching spot pairs from MongoDB...');
const pairs = await SpotPair.find({ status: 'active' });

console.log(`Found ${pairs.length} pairs. Loading to Redis...`);

for (const pair of pairs) {
  // Get currency images
  const firstCurrency = await Currency.findById(pair.firstCurrencyId);
  const secondCurrency = await Currency.findById(pair.secondCurrencyId);

  const pairData = {
    ...pair.toObject(),
    firstCurrencyImage: firstCurrency ? `http://localhost:3002/currency/${firstCurrency.image}` : '',
    secondCurrencyImage: secondCurrency ? `http://localhost:3002/currency/${secondCurrency.image}` : '',
  };

  // Store in Redis hash with prefix
  await redisClient.hset('cryptodex_spotPairdata', pair._id.toString(), JSON.stringify(pairData));
  console.log(`✅ Loaded ${pair.tikerRoot} to Redis`);
}

console.log('\nDone! All pairs loaded to Redis.');

await walletConn.close();
await spotConn.close();
redisClient.quit();
