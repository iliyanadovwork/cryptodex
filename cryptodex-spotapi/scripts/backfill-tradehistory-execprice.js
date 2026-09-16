/**
 * BACKFILL — tradeHistory.execPrice / tradeHistory.quantity
 *
 * WHAT WAS WRONG
 * --------------
 * Every trade is recorded twice under two field names: `tradePrice`/`tradeQty`
 * and `execPrice`/`quantity`. newTradeHistory only ever wrote the first pair, so
 * the second landed on its schema defaults of 0 — and the second pair is the one
 * report.controller.js projects (spotTradeUserHistory, the history export).
 * Those readers have been showing 0 for the price and size of real trades.
 *
 * controllers/spot.controller.js now writes both pairs, so rows created after
 * that fix are correct. This script repairs the rows written before it.
 *
 * WHY IT IS SAFE
 * --------------
 * The values are not lost, only unwritten: `tradePrice`/`tradeQty` on the SAME
 * document hold the execution. The backfill copies them across and touches
 * nothing else. It refuses any row where the copy would contradict the row's own
 * `orderValue` (price * qty), so a document that is internally inconsistent is
 * reported and skipped rather than "repaired" into a different lie.
 *
 * A row that already carries a non-zero execPrice/quantity is never rewritten.
 *
 * RUNNING
 * -------
 *   node scripts/backfill-tradehistory-execprice.js           # dry run
 *   node scripts/backfill-tradehistory-execprice.js --apply
 */

import mongoose from 'mongoose';

const APPLY = process.argv.includes('--apply');
const MONGO_URI = process.env.DATABASE_URI || 'mongodb://127.0.0.1:27017/cryptodex_spot';

// orderValue is stored as a float product, so it can only be compared loosely.
const ORDER_VALUE_TOLERANCE = 1e-6;

const main = async () => {
  await mongoose.connect(MONGO_URI);
  const collection = mongoose.connection.collection('tradeHistory');

  const rows = await collection
    .find({
      $or: [{ execPrice: { $in: [0, null] } }, { quantity: { $in: [0, null] } }],
      tradePrice: { $gt: 0 },
      tradeQty: { $gt: 0 }
    })
    .toArray();

  console.log(`${rows.length} tradeHistory row(s) with a zeroed execPrice/quantity`);

  let repaired = 0;
  let skipped = 0;

  for (const row of rows) {
    const price = row.tradePrice;
    const qty = row.tradeQty;

    if (row.orderValue != null && row.orderValue > 0) {
      const expected = price * qty;
      const drift = Math.abs(expected - row.orderValue);
      // Relative tolerance: a 200-USD trade and a 0.003-BTC trade cannot share
      // an absolute epsilon.
      if (drift > Math.max(ORDER_VALUE_TOLERANCE, Math.abs(row.orderValue) * 1e-9)) {
        skipped += 1;
        console.log(
          `  SKIP ${row._id}: tradePrice * tradeQty = ${expected} ` +
            `does not agree with orderValue ${row.orderValue} (drift ${drift})`
        );
        continue;
      }
    }

    repaired += 1;
    if (repaired <= 5 || !APPLY) {
      console.log(
        `  ${APPLY ? 'BACKFILL' : 'DRY RUN'} ${row._id} ${row.pairName || ''} ` +
          `execPrice ${row.execPrice} -> ${price}, quantity ${row.quantity} -> ${qty}` +
          `${row.orderValue != null ? ` (orderValue ${row.orderValue} = ${price} * ${qty})` : ''}`
      );
    }

    if (!APPLY) continue;

    await collection.updateOne(
      { _id: row._id },
      { $set: { execPrice: price, quantity: qty, execPriceBackfilledAt: new Date() } }
    );
  }

  console.log(
    `\n${repaired} row(s) ${APPLY ? 'backfilled' : 'would be backfilled'}, ${skipped} skipped`
  );
  if (!APPLY && repaired > 0) console.log('Dry run only. Re-run with --apply to write.');

  await mongoose.disconnect();
};

main().catch(async (err) => {
  console.error('backfill-tradehistory-execprice failed:', err);
  try {
    await mongoose.disconnect();
  } catch (e) {
    /* ignore */
  }
  process.exit(1);
});
