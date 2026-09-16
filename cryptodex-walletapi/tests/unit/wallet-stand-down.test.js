/**
 * STANDING A WALLET DOWN (BLOCKER)
 * ================================
 *
 * THE DEFECT THESE PIN
 * --------------------
 * userapi's `/deactive-confirm` has always had a mandatory wallet gate: it
 * calls the `deactivateWallet` gRPC method and refuses to deactivate anything
 * unless that call answers `status: true`. The method was declared ONLY in
 * userapi/grpc/wallet.proto - it was absent from this service's proto and from
 * grpc/server.js - so every call returned
 *
 *     12 UNIMPLEMENTED: The server does not implement the method
 *                       /Req/deactivateWallet
 *
 * (that line is in /tmp/user-api.log from before the fix), the gate failed, and
 * account deactivation was IMPOSSIBLE: HTTP 503 on every attempt, 100% of the
 * time, for every user.
 *
 * WHAT THE IMPLEMENTATION HAD TO DECIDE
 * -------------------------------------
 * "Stand down" is not self-defining. On a paper exchange there is no custody to
 * return and no fiat rail to close, so zeroing or deleting balances destroys
 * the only record of what the account held and buys nothing; it also makes an
 * accidental deactivation unrecoverable and is a write to a user balance ledger
 * that a deactivation path has no business making. The implementation therefore
 * MARKS the wallet and refuses further movement, leaving every balance exactly
 * where it is. These tests hold that choice in place explicitly - a future
 * "tidy-up" that starts zeroing balances fails here loudly.
 *
 * And it must be idempotent, because its caller is a multi-step cross-service
 * teardown that gets retried after partial failures.
 */

import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';

import {
  isStoodDown,
  standDownWallet,
  restoreWallet,
  checkStandDown,
  applyStandDownMode,
  makeFrozenWalletGuard,
  STAND_DOWN_REASON,
  STAND_DOWN_HTTP_STATUS,
  STAND_DOWN_STATUS,
} from '../../lib/walletStandDown.js';

const ROOT = path.join(__dirname, '../..');
const USER_ID = '6a7545c965f46feb2aae6424';

// ---------------------------------------------------------------------------
// A wallet model double that records every write, so a test can assert not only
// what was set but that NOTHING ELSE was.
// ---------------------------------------------------------------------------
const makeWalletModel = (initial) => {
  let doc = initial === undefined ? { _id: USER_ID, frozen: false } : initial;
  const updates = [];
  const model = {
    updates,
    get doc() {
      return doc;
    },
    findById: jest.fn((id) => ({
      select: () => ({
        lean: async () => {
          if (model.findThrows) throw new Error('mongo down');
          return doc && String(doc._id) === String(id) ? { ...doc } : null;
        },
      }),
    })),
    updateOne: jest.fn(async (filter, update) => {
      updates.push({ filter, update });
      if (model.updateThrows) throw new Error('E11000 duplicate key');
      if (model.updateIsANoop) return { matchedCount: 0, modifiedCount: 0 };
      // Honour the filter the way mongo would, so the idempotence guard is
      // actually exercised rather than assumed.
      if (filter.frozen && filter.frozen.$ne === true && doc.frozen === true) {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      doc = { ...doc, ...update.$set };
      return { matchedCount: 1, modifiedCount: 1 };
    }),
  };
  return model;
};

const withBalances = (over = {}) => ({
  _id: USER_ID,
  userCode: 'uc1',
  frozen: false,
  assets: [
    { coin: 'USD', spotBal: 9790, spotInOrder: 210 },
    { coin: 'USDC', spotBal: 10000, spotInOrder: 0 },
  ],
  ...over,
});

// ===========================================================================
// GUARD 1 - what counts as "stood down"
// ===========================================================================

describe('isStoodDown', () => {
  test('only an explicit boolean true locks a wallet out', () => {
    expect(isStoodDown({ frozen: true })).toBe(true);
  });

  test('every other value is LIVE, so nothing is locked out by accident', () => {
    // A truthy check here would lock out any wallet whose field was written as
    // a string by a migration or an admin tool.
    for (const value of ['true', 1, 'yes', {}, [], 'frozen']) {
      expect(isStoodDown({ frozen: value })).toBe(false);
    }
    for (const value of [false, 'false', 0, null, undefined, '']) {
      expect(isStoodDown({ frozen: value })).toBe(false);
    }
  });

  test('a wallet with no frozen field at all is live', () => {
    // Every wallet that predates the field. They must keep working.
    expect(isStoodDown({ _id: USER_ID, userCode: 'uc' })).toBe(false);
  });

  test('an absent wallet is not "stood down"', () => {
    expect(isStoodDown(null)).toBe(false);
    expect(isStoodDown(undefined)).toBe(false);
  });
});

// ===========================================================================
// GUARD 2 - standing down marks, and ONLY marks
// ===========================================================================

describe('standDownWallet', () => {
  test('marks a live wallet and says so', async () => {
    const Wallet = makeWalletModel();

    const result = await standDownWallet(Wallet, USER_ID);

    expect(result).toEqual({ status: true, message: 'FROZEN' });
    expect(Wallet.doc.frozen).toBe(true);
    expect(Wallet.doc.frozenAt).toBeInstanceOf(Date);
    expect(Wallet.doc.frozenReason).toBe(STAND_DOWN_REASON);
  });

  test('IT DOES NOT TOUCH A SINGLE BALANCE', async () => {
    // The whole design decision, asserted rather than described: the update
    // names three fields and none of them is money.
    const Wallet = makeWalletModel(withBalances());

    await standDownWallet(Wallet, USER_ID);

    expect(Wallet.updates).toHaveLength(1);
    expect(Object.keys(Wallet.updates[0].update)).toEqual(['$set']);
    expect(Object.keys(Wallet.updates[0].update.$set).sort()).toEqual([
      'frozen',
      'frozenAt',
      'frozenReason',
    ]);
    expect(Wallet.doc.assets).toEqual(withBalances().assets);
  });

  test('a second stand-down is a no-op that still reports success', async () => {
    const Wallet = makeWalletModel();

    const first = await standDownWallet(Wallet, USER_ID);
    const stampedAt = Wallet.doc.frozenAt;
    const second = await standDownWallet(Wallet, USER_ID);

    expect(first.message).toBe('FROZEN');
    expect(second).toEqual({ status: true, message: 'ALREADY_FROZEN' });
    // The FIRST closure's timestamp is the true one and must survive the retry:
    // it is the only record of when the account was closed.
    expect(Wallet.doc.frozenAt).toBe(stampedAt);
    expect(Wallet.updateOne).toHaveBeenCalledTimes(1);
  });

  test('the update is conditional on the wallet still being live', async () => {
    // Belt and braces for the concurrent-retry case: even if two calls get past
    // the read at the same time, only one write can match.
    const Wallet = makeWalletModel();

    await standDownWallet(Wallet, USER_ID);

    expect(Wallet.updates[0].filter).toEqual({
      _id: USER_ID,
      frozen: { $ne: true },
    });
  });

  test('a user with no wallet is vacuously stood down, not a permanent blocker', async () => {
    // Reporting failure here would resurrect the original bug - an account that
    // can NEVER be deactivated - for the users with the least to stand down.
    const Wallet = makeWalletModel(null);

    const result = await standDownWallet(Wallet, USER_ID);

    expect(result).toEqual({ status: true, message: 'NO_WALLET' });
    expect(Wallet.updateOne).not.toHaveBeenCalled();
  });

  test('a database that cannot be read is a FAILURE, not a pass', async () => {
    // "Unknown" is not "done". The caller refuses to deactivate on this.
    const Wallet = makeWalletModel();
    Wallet.findThrows = true;

    const result = await standDownWallet(Wallet, USER_ID);

    expect(result.status).toBe(false);
    expect(result.message).toBe('FREEZE_FAILED');
  });

  test('a write that throws is a failure', async () => {
    const Wallet = makeWalletModel();
    Wallet.updateThrows = true;

    const result = await standDownWallet(Wallet, USER_ID);

    expect(result.status).toBe(false);
    expect(result.message).toBe('FREEZE_FAILED');
  });

  test('a write that silently does nothing is a failure, not a success', async () => {
    // updateOne reporting modifiedCount 0 is ALSO the expected answer for a
    // racing retry, so the two are told apart by re-reading the state the
    // caller is being promised.
    const Wallet = makeWalletModel();
    Wallet.updateIsANoop = true;

    const result = await standDownWallet(Wallet, USER_ID);

    expect(result.status).toBe(false);
    expect(result.message).toBe('FREEZE_NOT_APPLIED');
  });

  test('a malformed user id is refused before any write', async () => {
    const Wallet = makeWalletModel();

    for (const bad of ['', 'not-an-objectid', null, undefined, '123', {}]) {
      const result = await standDownWallet(Wallet, bad);
      expect(result).toEqual({ status: false, message: 'INVALID_USER_ID' });
    }
    expect(Wallet.updateOne).not.toHaveBeenCalled();
    expect(Wallet.findById).not.toHaveBeenCalled();
  });

  test('an ObjectId-like value that is not a string is accepted', async () => {
    // What mongoose hands back on a document; the gRPC path sends a string.
    const Wallet = makeWalletModel();

    const result = await standDownWallet(Wallet, { toString: () => USER_ID });

    expect(result.status).toBe(true);
  });

  test('the recorded reason defaults to the deactivation reason', async () => {
    const Wallet = makeWalletModel();

    await standDownWallet(Wallet, USER_ID, '');

    expect(Wallet.doc.frozenReason).toBe(STAND_DOWN_REASON);
  });
});

// ===========================================================================
// GUARD 3 - restoring is the exact inverse, and equally idempotent
// ===========================================================================

describe('restoreWallet', () => {
  test('clears the mark and reports it', async () => {
    const Wallet = makeWalletModel({
      _id: USER_ID,
      frozen: true,
      frozenAt: new Date(),
      frozenReason: STAND_DOWN_REASON,
    });

    const result = await restoreWallet(Wallet, USER_ID);

    expect(result).toEqual({ status: true, message: 'RESTORED' });
    expect(Wallet.doc.frozen).toBe(false);
    expect(Wallet.doc.frozenAt).toBe(null);
    expect(Wallet.doc.frozenReason).toBe('');
  });

  test('restoring touches no balance either', async () => {
    const Wallet = makeWalletModel(withBalances({ frozen: true }));

    await restoreWallet(Wallet, USER_ID);

    expect(Object.keys(Wallet.updates[0].update.$set).sort()).toEqual([
      'frozen',
      'frozenAt',
      'frozenReason',
    ]);
    expect(Wallet.doc.assets).toEqual(withBalances().assets);
  });

  test('restoring a wallet that is already live is a no-op success', async () => {
    const Wallet = makeWalletModel();

    const result = await restoreWallet(Wallet, USER_ID);

    expect(result).toEqual({ status: true, message: 'ALREADY_LIVE' });
    expect(Wallet.updateOne).not.toHaveBeenCalled();
  });

  test('a user with no wallet is a no-op success', async () => {
    const Wallet = makeWalletModel(null);

    expect(await restoreWallet(Wallet, USER_ID)).toEqual({
      status: true,
      message: 'NO_WALLET',
    });
  });

  test('a malformed id is refused', async () => {
    const Wallet = makeWalletModel();

    expect(await restoreWallet(Wallet, 'nope')).toEqual({
      status: false,
      message: 'INVALID_USER_ID',
    });
  });

  test('an unreadable database is a failure', async () => {
    const Wallet = makeWalletModel({ _id: USER_ID, frozen: true });
    Wallet.findThrows = true;

    const result = await restoreWallet(Wallet, USER_ID);

    expect(result.status).toBe(false);
    expect(result.message).toBe('UNFREEZE_FAILED');
  });

  test('an unfreeze that does not take is a failure', async () => {
    const Wallet = makeWalletModel({ _id: USER_ID, frozen: true });
    Wallet.updateIsANoop = true;

    const result = await restoreWallet(Wallet, USER_ID);

    expect(result.status).toBe(false);
    expect(result.message).toBe('UNFREEZE_NOT_APPLIED');
  });

  test('freeze then restore then freeze again all work', async () => {
    const Wallet = makeWalletModel();

    expect((await standDownWallet(Wallet, USER_ID)).message).toBe('FROZEN');
    expect((await restoreWallet(Wallet, USER_ID)).message).toBe('RESTORED');
    expect((await standDownWallet(Wallet, USER_ID)).message).toBe('FROZEN');
    expect(Wallet.doc.frozen).toBe(true);
  });
});

// ===========================================================================
// GUARD 4 - the read-only preflight really is read-only
// ===========================================================================

describe('checkStandDown', () => {
  test('a live wallet is READY and is not written to', async () => {
    const Wallet = makeWalletModel();

    expect(await checkStandDown(Wallet, USER_ID)).toEqual({
      status: true,
      message: 'READY',
    });
    expect(Wallet.updateOne).not.toHaveBeenCalled();
  });

  test('an already-stood-down wallet reports so, still without writing', async () => {
    const Wallet = makeWalletModel({ _id: USER_ID, frozen: true });

    expect(await checkStandDown(Wallet, USER_ID)).toEqual({
      status: true,
      message: 'ALREADY_FROZEN',
    });
    expect(Wallet.updateOne).not.toHaveBeenCalled();
  });

  test('no wallet is a pass; an unreadable database is not', async () => {
    expect(await checkStandDown(makeWalletModel(null), USER_ID)).toEqual({
      status: true,
      message: 'NO_WALLET',
    });

    const broken = makeWalletModel();
    broken.findThrows = true;
    expect(await checkStandDown(broken, USER_ID)).toEqual({
      status: false,
      message: 'WALLET_LOOKUP_FAILED',
    });
  });

  test('a malformed id is refused', async () => {
    expect(await checkStandDown(makeWalletModel(), '0x1')).toEqual({
      status: false,
      message: 'INVALID_USER_ID',
    });
  });
});

// ===========================================================================
// GUARD 5 - the gRPC mode dispatch
// ===========================================================================

describe('applyStandDownMode', () => {
  test('an absent mode means freeze, so every existing caller keeps working', async () => {
    // userapi's client predates the field and proto3 sends "" for it.
    for (const mode of [undefined, null, '']) {
      const Wallet = makeWalletModel();
      const result = await applyStandDownMode(Wallet, USER_ID, mode);
      expect(result.message).toBe('FROZEN');
      expect(Wallet.doc.frozen).toBe(true);
    }
  });

  test('each named mode reaches its own operation', async () => {
    const frozen = makeWalletModel();
    expect((await applyStandDownMode(frozen, USER_ID, 'freeze')).message).toBe('FROZEN');
    expect((await applyStandDownMode(frozen, USER_ID, 'check')).message).toBe('ALREADY_FROZEN');
    expect((await applyStandDownMode(frozen, USER_ID, 'unfreeze')).message).toBe('RESTORED');
    expect(frozen.doc.frozen).toBe(false);
  });

  test('an unrecognised mode is REFUSED, never quietly defaulted', async () => {
    // Answering "done" to a request this service did not understand is how a
    // caller ends up believing a wallet was stood down when it was not.
    const Wallet = makeWalletModel();

    for (const mode of ['FREEZE', 'delete', 'zero', 'freeze ', 0, true, {}]) {
      const result = await applyStandDownMode(Wallet, USER_ID, mode);
      expect(result).toEqual({ status: false, message: 'UNKNOWN_MODE' });
    }
    expect(Wallet.updateOne).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// GUARD 6 - the HTTP guard on the money-moving routes
// ===========================================================================

describe('the stood-down wallet guard', () => {
  const runGuard = async (findWallet, req = { user: { id: USER_ID }, originalUrl: '/x' }) => {
    const out = { statusCode: null, body: null };
    const res = {
      status(code) {
        out.statusCode = code;
        return this;
      },
      json(payload) {
        out.body = payload;
        return this;
      },
    };
    const next = jest.fn();
    await makeFrozenWalletGuard({ findWallet })(req, res, next);
    return { out, next };
  };

  test('a live wallet passes through', async () => {
    const { out, next } = await runGuard(async () => ({ frozen: false }));

    expect(next).toHaveBeenCalled();
    expect(out.statusCode).toBe(null);
  });

  test('a wallet that does not exist passes through', async () => {
    // Nothing to refuse, and refusing would break every account whose wallet
    // has not been created yet.
    const { next } = await runGuard(async () => null);

    expect(next).toHaveBeenCalled();
  });

  test('a stood-down wallet is refused with 423 and a message that explains itself', async () => {
    const { out, next } = await runGuard(async () => ({ frozen: true }));

    expect(next).not.toHaveBeenCalled();
    expect(out.statusCode).toBe(STAND_DOWN_HTTP_STATUS);
    expect(out.statusCode).toBe(423);
    expect(out.body.success).toBe(false);
    expect(out.body.status).toBe(STAND_DOWN_STATUS);
    expect(out.body.message).toMatch(/balances are unchanged/i);
  });

  test('IT FAILS CLOSED: an unreadable wallet is refused, not waved through', async () => {
    const { out, next } = await runGuard(async () => {
      throw new Error('mongo down');
    });

    expect(next).not.toHaveBeenCalled();
    expect(out.statusCode).toBe(503);
    expect(out.body.status).toBe('WALLET_STATE_UNKNOWN');
  });

  test('a request with no authenticated user is refused', async () => {
    const { out, next } = await runGuard(async () => ({ frozen: false }), { user: null });

    expect(next).not.toHaveBeenCalled();
    expect(out.statusCode).toBe(401);
  });

  test('it looks the wallet up by the SESSION user, never by a body field', async () => {
    const seen = [];
    await runGuard(
      async (id) => {
        seen.push(id);
        return { frozen: false };
      },
      { user: { id: USER_ID }, body: { userId: 'aaaaaaaaaaaaaaaaaaaaaaaa' }, originalUrl: '/x' }
    );

    expect(seen).toEqual([USER_ID]);
  });
});

// ===========================================================================
// GUARD 7 - the wiring, which no unit test of the middleware can prove
// ===========================================================================
//
// controllers/wallet.controller.js imports every coin gateway at module scope
// and cannot be pulled into a unit test, so the fact that the guard is actually
// ON the money routes - and off the read routes - is asserted against the route
// source.

describe('route wiring', () => {
  const ROUTES = fs.readFileSync(path.join(ROOT, 'routes/wallet.route.js'), 'utf8');

  /** The middleware list express will run for `METHOD path`, as written. */
  const chainFor = (routePath, method) => {
    const at = ROUTES.indexOf(`.route("${routePath}")`);
    if (at === -1) return null;
    const rest = ROUTES.slice(at);
    const call = rest.indexOf(`.${method}(`);
    if (call === -1) return null;
    const from = call + method.length + 2;
    let depth = 1;
    let i = from;
    while (i < rest.length && depth > 0) {
      if (rest[i] === '(') depth++;
      else if (rest[i] === ')') depth--;
      i++;
    }
    return rest.slice(from, i - 1);
  };

  // The custody routes this list used to name - /coinWithdraw,
  // /coinWithdraw-app, /fiatWithdraw, /fiatDeposit and /createAddress - are
  // DELETED. They moved real money on a venue that holds none, and the operator
  // approve/reject workflow that completed them went with them.
  // A deleted route cannot lose its guard, so their absence is asserted in
  // GONE_ENTIRELY below instead; /transfer is the only value-moving route left,
  // and it still carries the full chain even though it answers 410.
  const MUST_BE_GUARDED = [
    ['/transfer', 'post', 'moves a balance between wallets'],
  ];

  const GONE_ENTIRELY = [
    '/coinWithdraw',
    '/coinWithdraw-app',
    '/fiatWithdraw',
    '/fiatDeposit',
    '/createAddress',
    '/userDeposit',
    '/getWithdrawLimit',
    '/fireblocksWebhook',
  ];

  test.each(GONE_ENTIRELY)('%s is not in the router at all', (routePath) => {
    expect(ROUTES).not.toContain(`"${routePath}"`);
    expect(ROUTES).not.toContain(`'${routePath}'`);
  });

  test.each(MUST_BE_GUARDED)(
    'POST %s carries blockFrozenWallet (%s)',
    (routePath, method, why) => {
      const chain = chainFor(routePath, method);
      expect(chain).not.toBe(null);
      expect(chain).toContain('walletCtrl.blockFrozenWallet');
    }
  );

  test.each(MUST_BE_GUARDED)(
    'POST %s authenticates before it checks the freeze',
    (routePath, method) => {
      // The guard reads req.user.id; ahead of passportAuth it would 401
      // everything instead of doing its job.
      const chain = chainFor(routePath, method);
      expect(chain.indexOf('passportAuth')).toBeGreaterThanOrEqual(0);
      expect(chain.indexOf('walletCtrl.blockFrozenWallet')).toBeGreaterThan(
        chain.indexOf('passportAuth')
      );
    }
  );

  test('the read routes are deliberately NOT guarded', () => {
    // A stood-down account, and the operator restoring it, must still be able
    // to see the balances. That is the whole point of marking instead of
    // zeroing.
    for (const [routePath, method] of [
      ['/getAssetsDetails', 'get'],
    ]) {
      const chain = chainFor(routePath, method);
      expect(chain).not.toBe(null);
      expect(chain).not.toContain('blockFrozenWallet');
    }
  });

  test('the guard is bound to a lookup by the session user', () => {
    const CONTROLLER = fs.readFileSync(
      path.join(ROOT, 'controllers/wallet.controller.js'),
      'utf8'
    );
    expect(CONTROLLER).toMatch(/blockFrozenWallet\s*=\s*makeFrozenWalletGuard/);
    expect(CONTROLLER).toMatch(/findWallet:\s*\(userId\)\s*=>\s*Wallet\.findById\(userId\)/);
  });
});

// ===========================================================================
// GUARD 8 - the contract really is served
// ===========================================================================
//
// The whole blocker was a method declared on one side of a wire and absent from
// the other. Nothing about that is visible from either service on its own, so
// it is asserted here against both files.

describe('the gRPC contract', () => {
  const SERVER_PROTO = fs.readFileSync(path.join(ROOT, 'grpc/wallet.proto'), 'utf8');
  const SERVER = fs.readFileSync(path.join(ROOT, 'grpc/server.js'), 'utf8');
  const CLIENT_PROTO_PATH = path.join(
    ROOT,
    '../cryptodex-userapi/grpc/wallet.proto'
  );

  test('walletapi DECLARES deactivateWallet', () => {
    expect(SERVER_PROTO).toMatch(/rpc\s+deactivateWallet\s*\(/);
    expect(SERVER_PROTO).toMatch(/message\s+deactivateWalletReq/);
    expect(SERVER_PROTO).toMatch(/message\s+deactivateWalletRes/);
  });

  test('walletapi SERVES deactivateWallet - the half that was missing', () => {
    expect(SERVER).toMatch(/deactivateWallet:\s*async/);
    expect(SERVER).toMatch(/from "\.\.\/controllers\/wallet\.js"/);
  });

  test("the client's copy of the contract still matches field for field", () => {
    if (!fs.existsSync(CLIENT_PROTO_PATH)) return; // sibling service not checked out
    const CLIENT_PROTO = fs.readFileSync(CLIENT_PROTO_PATH, 'utf8');
    const fields = (src, message) => {
      const at = src.indexOf(`message ${message}`);
      const body = src.slice(at, src.indexOf('}', at));
      return [...body.matchAll(/(\w+)\s*=\s*(\d+)/g)].map((m) => `${m[1]}=${m[2]}`);
    };
    expect(fields(CLIENT_PROTO, 'deactivateWalletReq')).toEqual(
      fields(SERVER_PROTO, 'deactivateWalletReq')
    );
    expect(fields(CLIENT_PROTO, 'deactivateWalletRes')).toEqual(
      fields(SERVER_PROTO, 'deactivateWalletRes')
    );
  });

  test('the wallet schema carries the mark the RPC writes', () => {
    const MODEL = fs.readFileSync(path.join(ROOT, 'models/wallet.js'), 'utf8');
    expect(MODEL).toMatch(/frozen:\s*{[\s\S]*?type:\s*Boolean[\s\S]*?default:\s*false/);
    expect(MODEL).toMatch(/frozenAt:/);
    expect(MODEL).toMatch(/frozenReason:/);
  });
});
