/**
 * THE SPOT MONEY-SUPPLY INVARIANT, MADE EXECUTABLE
 * ===============================================
 *
 * The prose lives in controllers/paperLedger.js under THE SPOT MONEY-SUPPLY
 * INVARIANT. Read it first; this file only pins it.
 *
 * WHY THIS TEST EXISTS. "Total value is conserved" is FALSE for spot on this
 * venue and is false on purpose: the counterparty on almost every fill is the
 * synthetic Binance-depth ladder, which is exempt from settlement in both
 * directions (controllers/spot.controller.js#settlementCredit), so one side of
 * a fill moves and the other does not. Because conservation was never going to
 * hold, nobody could use it as an alarm - and `POST /api/spot/requestWithdrawal`
 * sat there for the whole conversion debiting up to 10,000 USDC a call and
 * telling the caller the money had gone to a Solana address. It survived
 * several audits because a withdrawal that debits one account and credits
 * nobody looks exactly like a fill against the ladder if conservation is your
 * only instrument.
 *
 * So the invariant that replaces conservation is a CLOSED LIST: outside a fill,
 * the only code that may move a spot balance is the code named below. This test
 * is the thing that fails when a new mover appears.
 *
 * HOW IT LOOKS. It parses the service's own source and collects every function
 * that actually CALLS a spot-ledger write primitive - so it is immune to
 * comments (this repo's files are mostly comment), to renamed variables, and to
 * a doc block that merely mentions `walletbalance_spot`. A new writer fails the
 * test with the path and the reason.
 */

import { describe, test, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { parse } from '@babel/parser';

const SERVICE_ROOT = path.resolve(__dirname, '../..');
const SCANNED_DIRS = ['controllers', 'lib'];

/**
 * The redis hash every spot balance lives in, and the constant the ledger
 * module refers to it by. A write is only a spot write if it names one of them.
 */
const SPOT_KEYS = new Set(['walletbalance_spot']);
const SPOT_KEY_IDENTIFIERS = new Set(['SPOT_BALANCE_KEY']);

/** Redis primitives that MUTATE a hash field. `hget` is not one of them. */
const KEYED_WRITE_FNS = new Set([
  'hset',
  'hincbyfloat',
  'hincrbyfloatIfEnough',
  'hdel',
  'hsetnx',
  // The sanctioned mutation: moves the balance and appends its ledger entry in
  // one atomic step. It must be on this list, or the closed-list guard stops
  // seeing the ONE way a balance is now supposed to move and every migrated
  // call site becomes invisible to it.
  'moveBalanceLogged',
  // The unconditional signed variant: the drop-in for hincbyfloat. Without it
  // here, a file that has been fully migrated looks like a file that no longer
  // writes balances at all, and the closed list reports it as stale.
  'moveBalanceSigned'
]);

/**
 * Higher-level writers that carry the key inside them. A call to one of these
 * is a spot write no matter what its arguments look like.
 */
const IMPLICIT_WRITE_FNS = new Set(['adjustSpotBalance']);

/**
 * THE CLOSED LIST. Every entry is a file that may move a spot balance, with the
 * reason it is allowed to. Adding a file here is a deliberate act and should be
 * accompanied by an entry in the MINT / BURN / MOVE list in
 * controllers/paperLedger.js.
 */
const ALLOWED_WRITERS = {
  'controllers/paperLedger.js':
    'THE ledger module. Every deliberate credit/debit goes through it.',
  'controllers/spot.controller.js':
    'The matching engine: order reservation, fill settlement, cancel refund. ' +
    'This is the FILL half of the invariant, not the mint/burn half.',
  'controllers/faucet.controller.js':
    'MINT/BURN: faucet claim and demo reset - the venue\'s only user-facing ' +
    'source of demo money.',
  'controllers/binance.controller.js':
    'Dormant external-liquidity pass-through (liquidityType is hardcoded ' +
    '"off"). Kept on the list because it is loaded, not because it runs.',
  // NOT listed, deliberately: controllers/paperBook.controller.js. The
  // synthetic ladder writes the OPEN-ORDER hashes and never touches
  // walletbalance_spot - it is exempt from settlement in both directions
  // (spot.controller.js#settlementCredit), which is the reason the venue-wide
  // sum is not conserved. If it ever appears in the failure output, the ladder
  // has started keeping a balance and the exemption argument has to be redone.
};

const listFiles = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        walk(full);
      } else if (entry.name.endsWith('.js')) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
};

const namesSpotKey = (arg) => {
  if (!arg) return false;
  if (arg.type === 'StringLiteral') return SPOT_KEYS.has(arg.value);
  if (arg.type === 'Identifier') return SPOT_KEY_IDENTIFIERS.has(arg.name);
  if (arg.type === 'TemplateLiteral') {
    return arg.quasis.some((q) => SPOT_KEYS.has(q.value.cooked));
  }
  return false;
};

const calleeName = (callee) => {
  if (!callee) return null;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
    return callee.property.name;
  }
  return null;
};

/** Every CallExpression in `node`, found without a visitor library. */
const walkCalls = (node, onCall, seen = new Set()) => {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const child of node) walkCalls(child, onCall, seen);
    return;
  }
  if (node.type === 'CallExpression') onCall(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
    const value = node[key];
    if (value && typeof value === 'object') walkCalls(value, onCall, seen);
  }
};

/** Files under `controllers/` + `lib/` that contain a spot-ledger WRITE call. */
const findSpotWriters = () => {
  const writers = new Map();
  for (const dir of SCANNED_DIRS) {
    const abs = path.join(SERVICE_ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of listFiles(abs)) {
      const rel = path.relative(SERVICE_ROOT, file);
      const src = fs.readFileSync(file, 'utf8');
      const ast = parse(src, {
        sourceType: 'module',
        allowReturnOutsideFunction: true,
        plugins: ['classProperties', 'optionalChaining', 'nullishCoalescingOperator']
      });
      walkCalls(ast.program, (call) => {
        const name = calleeName(call.callee);
        if (!name) return;
        const isKeyedWrite =
          KEYED_WRITE_FNS.has(name) && namesSpotKey(call.arguments[0]);
        const isImplicitWrite = IMPLICIT_WRITE_FNS.has(name);
        if (!isKeyedWrite && !isImplicitWrite) return;
        if (!writers.has(rel)) writers.set(rel, new Set());
        writers.get(rel).add(name);
      });
    }
  }
  return writers;
};

describe('THE SPOT MONEY-SUPPLY INVARIANT', () => {
  test('the set of files that can move a spot balance is exactly the closed list', () => {
    const writers = findSpotWriters();
    const found = [...writers.keys()].sort();
    const allowed = Object.keys(ALLOWED_WRITERS).sort();

    const unexpected = found.filter((f) => !ALLOWED_WRITERS[f]);
    expect({
      unexpectedSpotBalanceWriters: unexpected,
      why:
        'A new file writes walletbalance_spot. Outside a fill, a spot balance ' +
        'may only move through an endpoint on the MINT / BURN / MOVE list in ' +
        'controllers/paperLedger.js. If this is a legitimate new mover, add it ' +
        'to BOTH lists; if it is a withdrawal, it is the defect this test exists ' +
        'to catch.'
    }).toEqual({ unexpectedSpotBalanceWriters: [], why: expect.any(String) });

    // And the list does not rot: an entry that no longer writes anything is a
    // permission granted to nobody, and hides the next real writer behind it.
    const stale = allowed.filter((f) => !writers.has(f));
    expect({ staleAllowlistEntries: stale }).toEqual({ staleAllowlistEntries: [] });
  });

  test('the withdrawal controller cannot move a balance at all', () => {
    // The specific regression. It is not enough that requestWithdrawal answers
    // 410 today: the module must not even be able to reach the ledger, so that
    // "restoring" the debit is a visible, multi-file change rather than
    // uncommenting one line.
    const file = path.join(SERVICE_ROOT, 'controllers/withdrawal.controller.js');
    const src = fs.readFileSync(file, 'utf8');

    expect(src).not.toMatch(/from\s+['"]\.\/paperLedger\.js['"]/);
    expect(src).not.toMatch(/from\s+['"]\.\/redis\.controller\.js['"]/);

    const ast = parse(src, { sourceType: 'module' });
    const calls = [];
    walkCalls(ast.program, (call) => {
      const name = calleeName(call.callee);
      if (
        IMPLICIT_WRITE_FNS.has(name) ||
        KEYED_WRITE_FNS.has(name) ||
        name === 'resolveAccount' ||
        name === 'readSpotBalance'
      ) {
        calls.push(name);
      }
    });
    expect({ ledgerCallsInWithdrawalController: calls }).toEqual({
      ledgerCallsInWithdrawalController: []
    });
  });

  test('the invariant is written down where an auditor will land', () => {
    // A comment can be deleted; this makes deleting it fail. The whole cost of
    // the requestWithdrawal defect was that the right invariant was in nobody's
    // head and nobody's file.
    const ledger = fs.readFileSync(
      path.join(SERVICE_ROOT, 'controllers/paperLedger.js'),
      'utf8'
    );
    expect(ledger).toContain('THE SPOT MONEY-SUPPLY INVARIANT');
    expect(ledger).toMatch(/NOT CONSERVED|IS FALSE FOR SPOT/);
    expect(ledger).toContain('MINT');
    expect(ledger).toContain('BURN');

    // and the fill-side exemption points at it, because that is the other place
    // an auditor starts from.
    const engine = fs.readFileSync(
      path.join(SERVICE_ROOT, 'controllers/spot.controller.js'),
      'utf8'
    );
    expect(engine).toContain('THE SPOT MONEY-SUPPLY INVARIANT');
  });
});
