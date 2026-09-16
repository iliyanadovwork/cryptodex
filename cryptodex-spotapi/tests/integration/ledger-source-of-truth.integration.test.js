/**
 * THE LEDGER IS THE SOURCE OF TRUTH. THE BALANCE IS A PROJECTION.
 * ===============================================================
 *
 * These run against a REAL redis, because the guarantee under test is one only
 * redis provides: a Lua script runs to completion before anything else, so the
 * balance movement and the ledger entry are one indivisible step. A mocked
 * redis would let the two drift apart exactly where the real one cannot, and
 * would therefore prove nothing.
 *
 * WHAT EACH TEST IS ACTUALLY PINNING
 * ----------------------------------
 * Not "the arithmetic works" - that is the easy half. These pin the properties
 * that make the ledger worth having:
 *
 *   - a refused movement leaves NO entry, so a replay never counts money that
 *     never moved;
 *   - a balance can be destroyed and recomputed, which is what "the balance is
 *     disposable" has to mean to be true;
 *   - reconcile NOTICES a corrupted balance rather than accepting it;
 *   - rebuild refuses an empty ledger, because "replayed to 0" and "there was
 *     nothing to replay" are the same number and opposite situations.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

let redisMod, ledgerMod, keys;

const KEY = 'walletbalance_spot';
const uniq = (tag) => `test_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

beforeAll(async () => {
  redisMod = await import('../../controllers/redis.controller.js');
  ledgerMod = await import('../../lib/ledger.js');
  keys = [];
});

afterAll(async () => {
  // Leave no test fields behind in a shared redis.
  for (const f of keys) {
    // The hash field AND its stream. Leaving streams behind would grow a shared
    // redis by one key per test per run, and a later reconcile of a recycled
    // field name would read someone else's history.
    try { await redisMod.hdel(KEY, f); } catch (e) { /* best effort */ }
    try { await redisMod.del(redisMod.ledgerStreamKey(f)); } catch (e) { /* best effort */ }
  }
});

const field = (tag) => {
  const f = uniq(tag);
  keys.push(f);
  return f;
};

describe('a movement and its ledger entry are one atomic step', () => {
  test('a credit moves the balance and records why', async () => {
    const f = field('credit');
    const out = await redisMod.moveBalanceLogged(KEY, f, 1000, {
      direction: 'credit', reason: 'faucet', ref: 'seed'
    });
    expect(parseFloat(out.balance)).toBe(1000);
    expect(out.entryId).toBeTruthy();

    const entries = await redisMod.readLedger(f);
    expect(entries).toHaveLength(1);
    expect(entries[0].reason).toBe('faucet');
    expect(entries[0].ref).toBe('seed');
    expect(parseFloat(entries[0].delta)).toBe(1000);
    expect(parseFloat(entries[0].before)).toBe(0);
    expect(parseFloat(entries[0].after)).toBe(1000);
  });

  test('a debit records a NEGATIVE delta, so a replay is a plain sum', async () => {
    const f = field('debit');
    await redisMod.moveBalanceLogged(KEY, f, 1000, { direction: 'credit', reason: 'faucet' });
    await redisMod.moveBalanceLogged(KEY, f, 250, { direction: 'debit', reason: 'reserve', ref: 'o1' });

    const entries = await redisMod.readLedger(f);
    expect(entries.map((e) => parseFloat(e.delta))).toEqual([1000, -250]);
    const { balance } = await ledgerMod.replayBalance(f);
    expect(balance).toBe(750);
  });

  // THE ONE THAT MATTERS. A refused debit that still logged would make the
  // replay claim money left an account it never left.
  test('a debit that cannot be afforded moves nothing AND logs nothing', async () => {
    const f = field('refused');
    await redisMod.moveBalanceLogged(KEY, f, 100, { direction: 'credit', reason: 'faucet' });

    const refused = await redisMod.moveBalanceLogged(KEY, f, 999999, {
      direction: 'debit', reason: 'too_big', ref: 'o9'
    });

    expect(refused).toBeNull();
    expect(parseFloat(await redisMod.hget(KEY, f))).toBe(100);
    const entries = await redisMod.readLedger(f);
    expect(entries).toHaveLength(1);              // the credit only
    expect(entries.every((e) => e.reason !== 'too_big')).toBe(true);
  });

  test('a debit held off by a freeze moves nothing and logs nothing', async () => {
    const f = field('frozen');
    const freeze = uniq('freeze_key');
    await redisMod.moveBalanceLogged(KEY, f, 500, { direction: 'credit', reason: 'faucet' });
    await redisMod.set(freeze, '1');

    const held = await redisMod.moveBalanceLogged(KEY, f, 10, {
      direction: 'debit', reason: 'reserve', freezeKey: freeze
    });

    expect(held).toBe('FROZEN');
    expect(parseFloat(await redisMod.hget(KEY, f))).toBe(500);
    expect(await redisMod.readLedger(f)).toHaveLength(1);
    await redisMod.del(freeze);
  });
});

describe('the balance is disposable', () => {
  test('a destroyed balance is recomputed exactly from the ledger', async () => {
    const f = field('rebuild');
    await redisMod.moveBalanceLogged(KEY, f, 1000, { direction: 'credit', reason: 'faucet' });
    await redisMod.moveBalanceLogged(KEY, f, 250, { direction: 'debit', reason: 'reserve', ref: 'o1' });
    await redisMod.moveBalanceLogged(KEY, f, 120, { direction: 'debit', reason: 'reserve', ref: 'o2' });
    await redisMod.moveBalanceLogged(KEY, f, 70, { direction: 'credit', reason: 'refund', ref: 'o2' });
    expect(parseFloat(await redisMod.hget(KEY, f))).toBe(700);

    await redisMod.hdel(KEY, f);                       // the crash
    expect(await redisMod.hget(KEY, f)).toBeNull();

    // coverageIsComplete: this field's every movement went through the ledger,
    // which the test controls and can therefore assert. rebuildBalance refuses
    // without it, because the service as a whole is not there yet.
    const out = await ledgerMod.rebuildBalance(f, {
      hset: redisMod.hset,
      coverageIsComplete: true,
    });
    expect(out.rebuilt).toBe(true);
    expect(out.balance).toBe(700);
    expect(parseFloat(await redisMod.hget(KEY, f))).toBe(700);
  });

  // "Replayed to 0" and "there was nothing to replay" are the same number.
  // Writing the first when you meant the second zeroes a live account.
  test('rebuild REFUSES a field with no ledger, rather than zeroing it', async () => {
    const f = field('noledger');
    await redisMod.hset(KEY, f, 4242);               // a balance older than the ledger

    const out = await ledgerMod.rebuildBalance(f, {
      hset: redisMod.hset,
      coverageIsComplete: true,
    });

    expect(out.rebuilt).toBe(false);
    expect(out.reason).toBe('no_ledger_entries');
    expect(parseFloat(await redisMod.hget(KEY, f))).toBe(4242);   // untouched
  });

  // A rebuild OVERWRITES a live balance from a replay. Reaching that through a
  // default rather than a decision is how a recovery tool becomes an outage.
  test('rebuild REFUSES unless the caller explicitly asks for it', async () => {
    const f = field('incomplete');
    await redisMod.moveBalanceLogged(KEY, f, 500, { direction: 'credit', reason: 'faucet' });
    await redisMod.hset(KEY, f, 123);

    const out = await ledgerMod.rebuildBalance(f, { hset: redisMod.hset });

    expect(out.rebuilt).toBe(false);
    expect(out.reason).toBe('rebuild_not_requested');
    expect(parseFloat(await redisMod.hget(KEY, f))).toBe(123);   // untouched
  });
});

describe('reconcile notices a balance that disagrees with its ledger', () => {
  test('a matching balance reconciles', async () => {
    const f = field('match');
    await redisMod.moveBalanceLogged(KEY, f, 900, { direction: 'credit', reason: 'faucet' });
    await redisMod.moveBalanceLogged(KEY, f, 400, { direction: 'debit', reason: 'reserve' });

    const r = await ledgerMod.reconcile(f);
    expect(r.ok).toBe(true);
    expect(r.live).toBe(500);
    expect(r.replayed).toBe(500);
    expect(Math.abs(r.drift)).toBeLessThanOrEqual(ledgerMod.RECONCILE_TOLERANCE);
  });

  // The failure this whole mechanism exists to make visible: something wrote a
  // balance without going through the ledger.
  test('a balance written behind the ledger is REPORTED, not accepted', async () => {
    const f = field('drift');
    await redisMod.moveBalanceLogged(KEY, f, 1000, { direction: 'credit', reason: 'faucet' });
    await redisMod.hset(KEY, f, 999999);             // an unlogged write

    const r = await ledgerMod.reconcile(f);
    expect(r.ok).toBe(false);
    expect(r.replayed).toBe(1000);
    expect(r.live).toBe(999999);
    expect(r.drift).toBeCloseTo(998999, 6);
  });

  // A field whose movements predate the ledger cannot be judged, and saying
  // "mismatch" would bury the real ones.
  test('an empty ledger reports "cannot say" rather than a mismatch', async () => {
    const f = field('unjudgeable');
    await redisMod.hset(KEY, f, 123);

    const r = await ledgerMod.reconcile(f);
    expect(r.ok).toBeNull();
    expect(r.reason).toBe('no_ledger_entries');
  });
});
