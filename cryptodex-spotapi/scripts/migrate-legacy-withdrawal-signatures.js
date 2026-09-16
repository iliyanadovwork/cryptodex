/**
 * MIGRATION - NOT RUN. Read this whole header before running it.
 *
 * WHAT
 * ----
 * `cryptodex_spot.withdrawalevents` contains rows written BEFORE Cryptodex became a
 * paper-trading exchange. Their `signature` field holds a real 88-character
 * base58 Solana transaction id, i.e. a signature for a transfer that this
 * exchange no longer performs. Everything issued since the conversion carries a
 * `paper-<epoch_ms>` signature and `network: "paper"`.
 *
 * WHY IT IS NOT RUN
 * -----------------
 * These rows are USER DATA (a user's own withdrawal history) and the live fix
 * for the "real-looking txid" problem is already in place and non-destructive:
 * controllers/withdrawal.controller.js never emits a non-paper signature as a
 * `txid`, and labels such rows `legacy: true`. Nothing needs the stored value
 * changed. Rewriting the database is therefore optional cleanup, and optional
 * cleanup on user data is not something to do silently.
 *
 * WHAT IT DOES IF YOU DO RUN IT
 * -----------------------------
 * For every row that is not paper-issued:
 *   - copies `signature`   -> `legacySignature`  (nothing is lost)
 *   - sets   `signature`   =  `legacy-<_id>`     (unique, obviously synthetic;
 *                                                 the collection has a unique
 *                                                 sparse index on `signature`)
 *   - sets   `network`     =  'legacy'
 *   - sets   `migratedAt`  =  now
 * No row is deleted, no balance is touched, and re-running is a no-op (rows are
 * selected by "signature does not start with paper- or legacy-").
 *
 * HOW TO RUN
 * ----------
 *   # dry run (default): prints exactly what WOULD change, writes nothing
 *   node scripts/migrate-legacy-withdrawal-signatures.js
 *
 *   # apply
 *   node scripts/migrate-legacy-withdrawal-signatures.js --apply
 *
 * Take a mongodump of `withdrawalevents` first. `legacySignature` is not in the
 * WithdrawalEvent schema, so read it back with the raw collection, not the
 * model, if you ever need it.
 */

import mongoose from 'mongoose';

const DEFAULT_URI = 'mongodb://127.0.0.1:27017/cryptodex_spot';
const APPLY = process.argv.includes('--apply');

// Rows that are NOT paper-issued and have not already been migrated.
const LEGACY_FILTER = {
  signature: { $exists: true, $nin: [null, ''], $not: /^(paper-|legacy-)/ },
  network: { $ne: 'paper' }
};

async function main() {
  await mongoose.connect(process.env.DATABASE_URI || DEFAULT_URI);
  const collection = mongoose.connection.collection('withdrawalevents');

  const rows = await collection.find(LEGACY_FILTER).toArray();
  console.log(`${rows.length} pre-conversion withdrawal row(s) found`);

  for (const row of rows) {
    const replacement = `legacy-${row._id.toString()}`;
    console.log(
      `${APPLY ? 'MIGRATE' : 'DRY RUN'} ${row._id.toString()} ` +
      `user=${row.userId} amount=${row.amountFormatted || row.amount} ` +
      `signature=${row.signature} -> ${replacement}`
    );
    if (!APPLY) continue;

    await collection.updateOne(
      { _id: row._id },
      {
        $set: {
          legacySignature: row.signature,
          signature: replacement,
          network: 'legacy',
          migratedAt: new Date()
        }
      }
    );
  }

  if (!APPLY && rows.length > 0) {
    console.log('\nDry run only. Re-run with --apply to write these changes.');
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('migrate-legacy-withdrawal-signatures failed:', err);
  try {
    await mongoose.disconnect();
  } catch (e) {
    /* ignore */
  }
  process.exit(1);
});
