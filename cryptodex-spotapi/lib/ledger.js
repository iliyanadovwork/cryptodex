/**
 * DERIVING A BALANCE FROM THE LEDGER, AND CHECKING THE TWO AGREE.
 * ==============================================================
 *
 * controllers/redis.controller.js appends a ledger entry inside the same atomic
 * step that moves a balance, so the stream is a complete record of every
 * movement rather than a commentary on some of them. This module is what makes
 * that worth having: it recomputes a balance from the entries, and it checks
 * the live balance against the recomputation.
 *
 * WHY THE REPLAY IS A SUM OF DELTAS AND NOT THE LAST `after`
 * ---------------------------------------------------------
 * Every entry carries both the delta and the `after` the script observed. The
 * last `after` is the cheaper answer and it is the WRONG one to trust: it is a
 * number one writer computed, so replaying it just re-asserts whatever that
 * writer believed. Summing the deltas recomputes the balance from the movements
 * themselves, which is the only version that can disagree with a corrupted
 * projection - and disagreeing is the entire point of having it.
 *
 * FLOATING POINT, HONESTLY
 * ------------------------
 * Balances are IEEE-754 doubles moved by HINCRBYFLOAT, so a replayed sum and a
 * live balance will differ in the last bits after enough movements. That is
 * arithmetic, not corruption. `reconcile` therefore compares within a tolerance
 * and reports the drift, rather than pretending an exact match is achievable.
 * A tolerance is a poor substitute for integer minor units; it is what this
 * ledger can offer without a migration of every stored balance.
 */

import { readLedger, ledgerLength } from "../controllers/redis.controller.js";
import { hget } from "../controllers/redis.controller.js";

/** Balances differing by less than this are the same number, arithmetically. */
export const RECONCILE_TOLERANCE = Number(
  process.env.LEDGER_RECONCILE_TOLERANCE || 1e-8
);

const SPOT_BALANCE_KEY = "walletbalance_spot";

/**
 * Recompute a balance from its ledger entries.
 *
 * Returns { balance, entries, firstId, lastId }. A field with no entries
 * replays to 0 with entries: 0 - which is NOT the same as "the balance is 0",
 * and callers must not treat it as a licence to overwrite a live balance. See
 * reconcile, which refuses to judge an empty ledger.
 */
export const replayBalance = async (field) => {
  const entries = await readLedger(field);
  if (entries.length === 0) {
    return { balance: 0, entries: 0, firstId: null, lastId: null, opening: 0 };
  }

  // START FROM THE OLDEST SURVIVING ENTRY'S `before`, NOT FROM ZERO.
  //
  // Summing deltas from zero silently assumes the stream contains the whole
  // history of the field, and it does not have to. Two ways it will not:
  //
  //   - a balance that existed BEFORE the ledger did. Every account that traded
  //     prior to this mechanism has one.
  //   - a stream trimmed by MAXLEN. That is the point of MAXLEN.
  //
  // In both cases a zero-based sum replays SHORT, and rebuildBalance would then
  // write that number over a correct balance and destroy the difference. The
  // oldest entry records what the balance was immediately before it, which is
  // exactly the opening figure the remaining deltas apply to.
  const opening = parseFloat(entries[0].before);
  let balance = Number.isFinite(opening) ? opening : 0;
  for (const e of entries) {
    const delta = parseFloat(e.delta);
    if (Number.isFinite(delta)) balance += delta;
  }
  return {
    balance,
    opening: Number.isFinite(opening) ? opening : 0,
    entries: entries.length,
    firstId: entries[0].id,
    lastId: entries[entries.length - 1].id,
  };
};

/**
 * Does the live balance match what the ledger says it should be?
 *
 * NOW AN ASSERTION, NOT ADVICE. Every write to a spendable balance goes through
 * the ledger, so a false here means the live balance is genuinely wrong - not
 * that some path forgot to log. That was true while the migration ran; it is
 * not true any more.
 *
 * `ok` is null rather than false when the ledger is empty: a field whose
 * movements all predate the ledger has nothing to be checked against, and
 * reporting that as a mismatch would bury the real ones. Callers should treat
 * null as "cannot say" and act only on false.
 */
export const reconcile = async (field, { key = SPOT_BALANCE_KEY } = {}) => {
  const live = parseFloat(await hget(key, field.toString()));
  const { balance: replayed, entries, lastId } = await replayBalance(field);

  if (entries === 0) {
    return { ok: null, reason: "no_ledger_entries", live, replayed: null, entries: 0 };
  }

  const liveNum = Number.isFinite(live) ? live : 0;
  const drift = liveNum - replayed;
  return {
    ok: Math.abs(drift) <= RECONCILE_TOLERANCE,
    live: liveNum,
    replayed,
    drift,
    entries,
    lastId,
  };
};

/**
 * Rebuild a live balance from its ledger.
 *
 * REFUSES ON AN EMPTY LEDGER, deliberately. "Replay produced 0" and "there is
 * nothing to replay" are the same number and opposite situations, and writing
 * the first when you meant the second zeroes a real account. The caller has to
 * have decided the ledger is authoritative for this field before asking.
 */
export const rebuildBalance = async (
  field,
  { key = SPOT_BALANCE_KEY, hset, coverageIsComplete = false } = {}
) => {
  // STILL AN EXPLICIT DECISION, THOUGH COVERAGE IS NOW COMPLETE.
  //
  // Every write to a spendable balance goes through the ledger, and
  // tests/unit/ledger-coverage.test.js fails the build if one stops doing so.
  // The refusal below is therefore no longer about missing entries.
  //
  // It stays because a rebuild OVERWRITES a live balance from a replay, and
  // that is not a thing to do by accident. The caller has to have decided this
  // field's history is the one it wants - after a restart, say, or a restore -
  // rather than reaching a rebuild through a default. `reconcile` answers "do
  // these agree" and writes nothing; it is what routine checks should call.
  if (!coverageIsComplete) {
    return { rebuilt: false, reason: "rebuild_not_requested" };
  }
  const count = await ledgerLength(field);
  if (count === 0) {
    return { rebuilt: false, reason: "no_ledger_entries" };
  }
  const { balance } = await replayBalance(field);
  if (typeof hset === "function") {
    await hset(key, field.toString(), balance);
  }
  return { rebuilt: true, balance, entries: count };
};

export default { replayBalance, reconcile, rebuildBalance, RECONCILE_TOLERANCE };
