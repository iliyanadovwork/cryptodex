import Binance from 'node-binance-api';
import mongoose from 'mongoose';
import { hset } from '../controllers/redis.controller.js';
import { SpotPair } from '../models/index.js';
import { replacePair } from '../lib/pairHelper.js';

// Binance API config
const binance = new Binance().options({
  APIKEY: process.env.BINANCE_API_KEY,
  APISECRET: process.env.BINANCE_SECRET_KEY,
  useServerTime: true,
});

async function updatePrices() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.DATABASE_URI || 'mongodb://127.0.0.1:27017/cryptodex_spot');
    console.log('Connected to MongoDB');

    // Get all active pairs with botstatus = 'binance'
    const pairs = await SpotPair.find({ status: 'active', botstatus: 'binance' }).lean();
    console.log(`Found ${pairs.length} pairs to update`);

    for (const pair of pairs) {
      try {
        const pairName = pair.tikerRoot || `${pair.firstCurrencySymbol}${pair.secondCurrencySymbol}`;
        const binanceSymbol = replacePair(pair.secondCurrencySymbol);
        const fullSymbol = `${pair.firstCurrencySymbol}${binanceSymbol}`;

        // Fetch current price from Binance
        const ticker = await binance.prices(fullSymbol);

        if (ticker && ticker[fullSymbol]) {
          const price = parseFloat(ticker[fullSymbol]);
          const prevPrice = price * 0.99; // Approximate previous price for change calc
          const change = ((price - prevPrice) / prevPrice) * 100;
          const high = price * 1.01;
          const low = price * 0.99;

          // Create updated pair data for spotPairdata cache
          const updatedPair = {
            ...pair,
            markPrice: price,
            last: price,
            change: change.toFixed(2),
            changePrice: (price - prevPrice).toFixed(2),
            high: high,
            low: low,
            firstVolume: (Math.random() * 1000).toFixed(2),
            secondVolume: (Math.random() * 1000000).toFixed(2),
          };

          // Create 24hr change data for spot24hrsChange cache
          const changeData = {
            markPrice: price,
            last: price,
            change: change.toFixed(2),
            changePrice: (price - prevPrice).toFixed(2),
            high: high,
            low: low,
            firstVolume: (Math.random() * 1000).toFixed(2),
            secondVolume: (Math.random() * 1000000).toFixed(2),
            botstatus: 'binance',
            firstCurrencySymbol: pair.firstCurrencySymbol,
            secondCurrencySymbol: pair.secondCurrencySymbol,
            _id: pair._id.toString(),
          };

          // Update both Redis caches (hset will JSON.stringify the data)
          await hset('spotPairdata', pair._id.toString(), updatedPair);
          await hset('spot24hrsChange', pair._id.toString(), changeData);
          console.log(`Updated ${pair.pairName}: $${price}`);
        }
      } catch (err) {
        console.log(`Error updating ${pair.pairName}:`, err.message);
      }
    }

    console.log('Price update complete');
    process.exit(0);
  } catch (err) {
    console.log('Error:', err);
    process.exit(1);
  }
}

updatePrices();
