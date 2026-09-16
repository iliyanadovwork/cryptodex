/**
 * NOTHING MAY MOVE A BALANCE WITHOUT LEAVING A LEDGER ENTRY.
 * ==========================================================
 *
 * lib/ledger.js can only recompute a balance if the ledger records every
 * movement. One unlogged write and the replay is wrong - and worse, it is
 * confidently wrong, because a rebuild would then restore an account to a
 * number that omits whatever was written behind the ledger's back.
 *
 * The property is therefore not "the ledger works" but "there is no second way
 * in", and that is a property of the SOURCE, not of any single execution. So
 * this reads the source: any call that moves `walletbalance_spot` must go
 * through moveBalanceLogged.
 *
 * WHY A SOURCE SCAN AND NOT A RUNTIME ASSERTION
 * ---------------------------------------------
 * A runtime check only fires on paths a test happens to exercise. The defect
 * this guards against is a NEW path added later by someone who does not know
 * the rule - which is exactly the path no existing test covers. A scan sees it
 * the moment it is written.
 *
 * WHEN THIS FAILS, the fix is to route the new call through moveBalanceLogged,
 * not to add it to the allowlist. The allowlist is for writes that are not
 * balances at all.
 */

import { describe, test, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';

// __dirname, as the other source-scanning suites in this service use: jest runs
// these through babel as CommonJS, so import.meta is not available.
const ROOT = path.resolve(__dirname, '..', '..');

/**
 * The hash that holds real, spendable balances - by literal AND by the constant
 * modules refer to it as.
 *
 * Matching only the literal is how two unlogged writes survived this scan while
 * it reported a clean sweep: paperLedger and the faucet both write
 * `hset(SPOT_BALANCE_KEY, ...)`, and the string 'walletbalance_spot' appears
 * nowhere near those calls. A guard that cannot see the thing it guards is
 * worse than no guard, because it is believed.
 */
const BALANCE_KEY = 'walletbalance_spot';
const BALANCE_KEY_IDENTIFIERS = ['SPOT_BALANCE_KEY'];

/**
 * Writes that are NOT movements of a spendable balance.
 *
 * `walletbalance_spot_inOrder` and `_locked` are RESERVATION COUNTERS: they
 * record how much of a balance is already committed to open orders. Money does
 * not enter or leave the account when they change - the same coins are simply
 * described differently - so they are deliberately not ledger events. Putting
 * them in the stream would make a replay double-count every reservation.
 */
const NOT_A_BALANCE = [
  'walletbalance_spot_inOrder',
  'walletbalance_spot_locked',
];

const sourceFiles = () => {
  const out = [];
  for (const dir of ['controllers', 'lib']) {
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) out.push(full);
      }
    };
    walk(path.join(ROOT, dir));
  }
  return out;
};

/** Lines that call a raw increment against the spendable-balance hash. */
const rawBalanceWrites = () => {
  const hits = [];
  for (const file of sourceFiles()) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      // hset too: an absolute SET of a balance field is a movement the ledger
      // never sees, and setSpotBalance (the faucet reset) is exactly that.
      if (!/hincbyfloat\(|hincrbyfloatIfEnough\(|hset\(/.test(line)) return;

      // The call's key argument may be on this line or the next few.
      const window = lines.slice(i, i + 4).join(' ');
      if (NOT_A_BALANCE.some((k) => window.includes(k))) return;
      const namesBalance =
        window.includes(BALANCE_KEY) ||
        BALANCE_KEY_IDENTIFIERS.some((id) => window.includes(id));
      if (!namesBalance) return;

      hits.push(`${path.relative(ROOT, file)}:${i + 1}  ${trimmed.slice(0, 80)}`);
    });
  }
  return hits;
};

/**
 * THE MIGRATION IS PARTIAL, AND THIS IS THE RATCHET.
 *
 * Routing every balance movement through the ledger means touching ~20 call
 * sites, most of them inside the settlement path, which is precisely where a
 * hand-edit introduces a mint or a burn. Doing them all in one pass would be
 * the riskiest possible way to improve safety.
 *
 * So the remaining direct writes are recorded here as a BUDGET. The test fails
 * if a file gains one, which stops the problem growing while the migration
 * proceeds; and it fails if a file loses one without this number being lowered,
 * which stops the budget rotting into a number nobody trusts.
 *
 * THIS TABLE MAY ONLY EVER GO DOWN. A new balance-moving call must use
 * moveBalanceLogged; it must not be added here.
 */
const UNMIGRATED_DIRECT_WRITES = {
  // EMPTY. Every write to a spendable balance now goes through the ledger.
  //
  // It held 20 while the migration ran, and the two tests below did the work:
  // one refused to let a file gain a write, the other refused to let a file
  // keep budget it no longer needed. A ratchet is only useful if both halves
  // are enforced - a budget that can be left high after a migration is just a
  // number nobody trusts.
  //
  // Adding an entry here to make a failing build pass is the one thing this
  // must never be used for. Route the call through moveBalanceLogged (checked
  // debit) or moveBalanceSigned (unconditional signed apply) instead.
};

describe('every movement of a spendable balance goes through the ledger', () => {
  test('no file has MORE direct writes than its recorded budget', () => {
    const byFile = {};
    for (const hit of rawBalanceWrites()) {
      const file = hit.split(':')[0];
      byFile[file] = (byFile[file] || 0) + 1;
    }
    for (const [file, count] of Object.entries(byFile)) {
      const budget = UNMIGRATED_DIRECT_WRITES[file] ?? 0;
      expect({ file, count }).toEqual({ file, count: expect.any(Number) });
      expect(count).toBeLessThanOrEqual(budget);
    }
  });

  test('a file that has been migrated is removed from the budget', () => {
    const byFile = {};
    for (const hit of rawBalanceWrites()) {
      const file = hit.split(':')[0];
      byFile[file] = (byFile[file] || 0) + 1;
    }
    for (const [file, budget] of Object.entries(UNMIGRATED_DIRECT_WRITES)) {
      const actual = byFile[file] || 0;
      // Lower the budget when you migrate a call. Leaving it high hides the
      // next regression behind slack that was already spent.
      expect({ file, actual, budget }).toEqual({ file, actual, budget: actual });
    }
  });

  test('the ledger is genuinely in use on the settlement path', () => {
    const spot = fs.readFileSync(
      path.join(ROOT, 'controllers', 'spot.controller.js'),
      'utf8'
    );
    expect(spot).toContain('moveBalanceLogged(');
    // settlementCredit is the credit leg of every fill - the single movement a
    // user is most entitled to a record of.
    // The function body, bounded by its own closing brace rather than a
    // character count - a comment added above the call must not break this.
    const from = spot.indexOf('const settlementCredit');
    const settlement = spot.slice(from, spot.indexOf('\n};', from));
    expect(settlement).toContain('moveBalanceLogged(');
  });

  // Guards the guard. If the scan stopped matching anything at all - a renamed
  // helper, a changed key - it would pass vacuously and this property would
  // quietly stop being enforced.
  test('the scan is actually looking at something', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(20);

    const anyBalanceMention = files.some((f) =>
      fs.readFileSync(f, 'utf8').includes(BALANCE_KEY)
    );
    expect(anyBalanceMention).toBe(true);

    const ledgerUsed = files.some((f) =>
      fs.readFileSync(f, 'utf8').includes('moveBalanceLogged(')
    );
    expect(ledgerUsed).toBe(true);

    // The constant form must be reachable by the scan, or the two files that
    // use it become invisible again and this suite goes back to lying.
    const usesConstant = files.some((f) =>
      fs.readFileSync(f, 'utf8').includes('SPOT_BALANCE_KEY')
    );
    expect(usesConstant).toBe(true);
  });

  // The reservation counters must stay OUT, or a replay double-counts.
  test('reservation counters are excluded, not ledgered', () => {
    const ledgerFile = fs.readFileSync(
      path.join(ROOT, 'lib', 'ledger.js'),
      'utf8'
    );
    expect(ledgerFile).not.toContain('walletbalance_spot_inOrder');
  });
});
