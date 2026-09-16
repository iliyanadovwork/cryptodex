/**
 * A MARK-ONLY STAND-DOWN DID NOT STOP WALLET TRANSFERS
 * ====================================================
 *
 * THE DEFECT THESE PIN
 * --------------------
 * A stand-down reaches an account through two different doors:
 *
 *   - walletapi's own `wallet.frozen`, set by `standDownWallet` when userapi
 *     runs an account deactivation; and
 *   - the SHARED stand-down mark in redis, `STAND_DOWN_HASH`, written when a
 *     deactivation stands an account down outside this service, and READ by
 *     spot.
 *
 * `blockFrozenWallet` read only the first. An account stood down through the
 * shared mark therefore had a mark in redis and NO `frozen: true` on its wallet
 * document - nothing in that path calls back into walletapi to set one - and so
 * it was refused by spot while
 * remaining free to walk into `POST /api/wallet/transfer`, `/coinWithdraw`,
 * `/coinWithdraw-app`, `/fiatWithdraw`, `/fiatDeposit` or `/createAddress` and
 * move its money. The freeze was honoured by every service except the one that
 * holds the balances.
 *
 * WHAT IS ASSERTED
 * ----------------
 * That the guard consults BOTH sources, that the wallet DOCUMENT remains the
 * authority (it is read first, and it alone can refuse without redis being
 * asked at all), that either source saying "frozen" refuses, and that an
 * unreadable source is UNKNOWN - a 503 refusal, never a pass.
 *
 * THE OVER-CORRECTION MUTANTS MATTER JUST AS MUCH
 * -----------------------------------------------
 * A guard that refuses a live account, a guard that treats an absent mark as a
 * freeze, a guard that stops reading the wallet document, and any writer added
 * to the shared mark - which this service must never write, because it already
 * owns an authoritative record of the same fact - all fail here.
 */

import { describe, test, expect, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';

import {
  STAND_DOWN_HASH,
  STAND_DOWN_HTTP_STATUS,
  STAND_DOWN_STATUS,
  STAND_DOWN_UNKNOWN_HTTP_STATUS,
  STAND_DOWN_UNKNOWN_STATUS,
  isCorruptRecord,
  makeFrozenWalletGuard,
  parseStandDownRecord,
  readStandDownMark,
} from '../../lib/walletStandDown.js';

import * as standDownLib from '../../lib/walletStandDown.js';

const ROOT = path.join(__dirname, '../..');
const USER_ID = '6a7545c965f46feb2aae6424';
const OTHER_ID = '6a70fe409c46d957cd45ba3a';

// ---------------------------------------------------------------------------
// A redis double that records every call, so a test can assert not only what
// was read but that NOTHING WAS WRITTEN.
// ---------------------------------------------------------------------------
const makeRedis = ({ store = {}, fail = false } = {}) => {
  const reads = [];
  const writes = [];
  return {
    reads,
    writes,
    hget: async (hash, field) => {
      reads.push({ hash, field: String(field) });
      if (fail) throw new Error('redis down');
      const h = store[hash];
      return h && h[String(field)] !== undefined ? h[String(field)] : null;
    },
    // Present ONLY so that a guard which starts writing the shared mark is
    // caught red-handed rather than silently succeeding against a double that
    // does not offer a writer.
    hset: async (hash, field, value) => {
      writes.push({ op: 'hset', hash, field: String(field), value });
      return 1;
    },
    hdel: async (hash, field) => {
      writes.push({ op: 'hdel', hash, field: String(field) });
      return 1;
    },
  };
};

const frozenRow = (record = { frozen: true, frozenAt: '2026-08-07T00:00:00.000Z' }) =>
  JSON.stringify(record);

// ===========================================================================
// 1. READING THE SHARED MARK
// ===========================================================================

describe('readStandDownMark', () => {
  test('reads the SAME hash every other service addresses - renaming it on one side only silently un-freezes every stand-down marked there', async () => {
    expect(STAND_DOWN_HASH).toBe('account_standdown');
    const redis = makeRedis();
    await readStandDownMark(redis, USER_ID);
    expect(redis.reads).toEqual([{ hash: 'account_standdown', field: USER_ID }]);
  });

  test('a frozen record is frozen and known', async () => {
    const redis = makeRedis({ store: { [STAND_DOWN_HASH]: { [USER_ID]: frozenRow() } } });
    expect(await readStandDownMark(redis, USER_ID)).toEqual(
      expect.objectContaining({ known: true, frozen: true })
    );
  });

  test('no record at all is LIVE, not frozen', async () => {
    const redis = makeRedis();
    expect(await readStandDownMark(redis, USER_ID)).toEqual(
      expect.objectContaining({ known: true, frozen: false })
    );
  });

  test("another user's freeze does not stand this one down", async () => {
    const redis = makeRedis({
      store: { [STAND_DOWN_HASH]: { [OTHER_ID]: frozenRow() } },
    });
    expect((await readStandDownMark(redis, USER_ID)).frozen).toBe(false);
  });

  test('an explicit { frozen: false } record is LIVE', async () => {
    const redis = makeRedis({
      store: { [STAND_DOWN_HASH]: { [USER_ID]: frozenRow({ frozen: false }) } },
    });
    expect(await readStandDownMark(redis, USER_ID)).toEqual(
      expect.objectContaining({ known: true, frozen: false })
    );
  });

  test('a record too damaged to parse is UNKNOWN - never quietly treated as live', async () => {
    const redis = makeRedis({
      store: { [STAND_DOWN_HASH]: { [USER_ID]: '{"frozen":tr' } },
    });
    expect(await readStandDownMark(redis, USER_ID)).toEqual(
      expect.objectContaining({ known: false, frozen: false })
    );
  });

  test('a JSON scalar is UNKNOWN, not live', async () => {
    const redis = makeRedis({ store: { [STAND_DOWN_HASH]: { [USER_ID]: 'false' } } });
    expect((await readStandDownMark(redis, USER_ID)).known).toBe(false);
  });

  test('redis throwing is UNKNOWN, not live, and does not reject', async () => {
    const redis = makeRedis({ fail: true });
    await expect(readStandDownMark(redis, USER_ID)).resolves.toEqual(
      expect.objectContaining({ known: false, frozen: false })
    );
  });

  test('an id that is not a mongo id has no field in the hash, so redis is not even asked', async () => {
    const redis = makeRedis();
    expect(await readStandDownMark(redis, 'not-an-id')).toEqual(
      expect.objectContaining({ known: true, frozen: false, invalidId: true })
    );
    expect(redis.reads).toEqual([]);
  });

  test('an ObjectId-like object is normalised to its hex string', async () => {
    const redis = makeRedis({
      store: { [STAND_DOWN_HASH]: { [USER_ID]: frozenRow() } },
    });
    expect((await readStandDownMark(redis, { toString: () => USER_ID })).frozen).toBe(true);
  });

  test('parseStandDownRecord distinguishes absent from corrupt', () => {
    expect(parseStandDownRecord(null)).toBeNull();
    expect(parseStandDownRecord('')).toBeNull();
    expect(parseStandDownRecord('{"frozen":true}')).toEqual({ frozen: true });
    expect(isCorruptRecord(parseStandDownRecord('nonsense'))).toBe(true);
    expect(isCorruptRecord(parseStandDownRecord(null))).toBe(false);
    expect(isCorruptRecord({ frozen: true, corrupt: true })).toBe(false);
  });

  test('reading the mark NEVER writes it - this service already owns an authoritative record of the same fact', async () => {
    const redis = makeRedis({
      store: { [STAND_DOWN_HASH]: { [USER_ID]: frozenRow() } },
    });
    await readStandDownMark(redis, USER_ID);
    await readStandDownMark(redis, OTHER_ID);
    await readStandDownMark(makeRedis({ fail: true }), USER_ID);
    expect(redis.writes).toEqual([]);
  });

  test('the lib exports no writer for the shared mark, so there is none to call by mistake', () => {
    for (const name of ['markStandDown', 'clearStandDown', 'writeStandDownMark', 'setStandDownMark']) {
      expect(standDownLib[name]).toBeUndefined();
    }
  });
});

// ===========================================================================
// 2. THE GUARD, WITH BOTH SOURCES
// ===========================================================================

describe('blockFrozenWallet consults both sources', () => {
  const runGuard = async ({ wallet, mark, walletThrows, markThrows }) => {
    const calls = { wallet: 0, mark: 0 };
    const findWallet = async () => {
      calls.wallet += 1;
      if (walletThrows) throw new Error('mongo down');
      return wallet;
    };
    const readMark = async () => {
      calls.mark += 1;
      if (markThrows) throw new Error('redis down');
      return mark;
    };
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
    await makeFrozenWalletGuard({ findWallet, readMark })(
      { user: { id: USER_ID }, originalUrl: '/api/wallet/transfer' },
      res,
      next
    );
    return { out, next, calls };
  };

  const LIVE_MARK = { known: true, frozen: false };
  const FROZEN_MARK = { known: true, frozen: true };
  const UNREADABLE_MARK = { known: false, frozen: false };

  test('THE BUG: a mark-only stand-down - a mark, and a wallet document that says nothing - is now refused with 423', async () => {
    const { out, next } = await runGuard({ wallet: { frozen: false }, mark: FROZEN_MARK });
    expect(next).not.toHaveBeenCalled();
    expect(out.statusCode).toBe(STAND_DOWN_HTTP_STATUS);
    expect(out.statusCode).toBe(423);
    expect(out.body.status).toBe(STAND_DOWN_STATUS);
    expect(out.body.message).toMatch(/balances are unchanged/i);
  });

  test('the refusal a MARK produces is byte-for-byte the refusal the DOCUMENT produces, so no client has to learn a second vocabulary', async () => {
    const byMark = await runGuard({ wallet: { frozen: false }, mark: FROZEN_MARK });
    const byDoc = await runGuard({ wallet: { frozen: true }, mark: LIVE_MARK });
    expect(byMark.out).toEqual(byDoc.out);
  });

  test('the status codes are the LITERAL strings clients already key on - renaming either is a breaking change, not a refactor', async () => {
    // Asserted against the literals rather than against the exported constants,
    // which would make the assertion agree with any rename by construction.
    expect(STAND_DOWN_STATUS).toBe('WALLET_STOOD_DOWN');
    expect(STAND_DOWN_UNKNOWN_STATUS).toBe('WALLET_STATE_UNKNOWN');

    const frozen = await runGuard({ wallet: { frozen: false }, mark: FROZEN_MARK });
    expect(frozen.out.body).toEqual({
      success: false,
      status: 'WALLET_STOOD_DOWN',
      message:
        'This wallet has been stood down because the account was deactivated. Your balances are unchanged. Contact support to restore the account.',
    });

    const unknown = await runGuard({ wallet: { frozen: false }, mark: UNREADABLE_MARK });
    expect(unknown.out.body).toEqual({
      success: false,
      status: 'WALLET_STATE_UNKNOWN',
      message: 'Could not verify the wallet state. Please try again shortly.',
    });
  });

  test('a marked account with no wallet document at all is refused too', async () => {
    const { out, next } = await runGuard({ wallet: null, mark: FROZEN_MARK });
    expect(next).not.toHaveBeenCalled();
    expect(out.statusCode).toBe(423);
  });

  test('THE DOCUMENT IS STILL THE AUTHORITY: it is read first, and it alone can refuse without redis being asked at all', async () => {
    const { out, next, calls } = await runGuard({
      wallet: { frozen: true },
      mark: LIVE_MARK,
    });
    expect(out.statusCode).toBe(423);
    expect(next).not.toHaveBeenCalled();
    expect(calls.wallet).toBe(1);
    expect(calls.mark).toBe(0);
  });

  test('an unreadable wallet document refuses without consulting the mark - the authority failing is enough', async () => {
    const { out, next, calls } = await runGuard({ walletThrows: true, mark: FROZEN_MARK });
    expect(out.statusCode).toBe(STAND_DOWN_UNKNOWN_HTTP_STATUS);
    expect(out.statusCode).toBe(503);
    expect(out.body.status).toBe(STAND_DOWN_UNKNOWN_STATUS);
    expect(next).not.toHaveBeenCalled();
    expect(calls.mark).toBe(0);
  });

  test('IT FAILS CLOSED ON THE SECOND SOURCE TOO: an unreadable mark is a 503, not a pass', async () => {
    const { out, next } = await runGuard({
      wallet: { frozen: false },
      mark: UNREADABLE_MARK,
    });
    expect(next).not.toHaveBeenCalled();
    expect(out.statusCode).toBe(503);
    expect(out.body.status).toBe(STAND_DOWN_UNKNOWN_STATUS);
  });

  test('a mark reader that THROWS is a 503, not an unhandled rejection and not a pass', async () => {
    const { out, next } = await runGuard({ wallet: { frozen: false }, markThrows: true });
    expect(next).not.toHaveBeenCalled();
    expect(out.statusCode).toBe(503);
  });

  test('a mark reader that answers a shape the guard does not understand is a 503, not a pass', async () => {
    const { out, next } = await runGuard({ wallet: { frozen: false }, mark: undefined });
    expect(next).not.toHaveBeenCalled();
    expect(out.statusCode).toBe(503);
  });

  test('a frozen mark wins over an unknown one', async () => {
    const { out } = await runGuard({
      wallet: { frozen: false },
      mark: { known: false, frozen: true },
    });
    expect(out.statusCode).toBe(423);
  });

  // ---- OVER-CORRECTION MUTANTS -------------------------------------------

  test('a live wallet with a live mark still passes through, calling next() exactly once', async () => {
    const { out, next, calls } = await runGuard({
      wallet: { frozen: false },
      mark: LIVE_MARK,
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(out.statusCode).toBe(null);
    expect(calls.wallet).toBe(1);
    expect(calls.mark).toBe(1);
  });

  test('an account with NO wallet document and NO mark still passes - refusing would break every account whose wallet has not been created yet', async () => {
    const { out, next } = await runGuard({ wallet: null, mark: LIVE_MARK });
    expect(next).toHaveBeenCalledTimes(1);
    expect(out.statusCode).toBe(null);
  });

  test('a guard built with no mark source at all behaves exactly as it did before - the document alone decides, and it is never LESS strict', async () => {
    const call = async (wallet) => {
      const out = { statusCode: null };
      const res = {
        status(c) {
          out.statusCode = c;
          return this;
        },
        json() {
          return this;
        },
      };
      const next = jest.fn();
      await makeFrozenWalletGuard({ findWallet: async () => wallet })(
        { user: { id: USER_ID }, originalUrl: '/x' },
        res,
        next
      );
      return { out, next };
    };
    const live = await call({ frozen: false });
    expect(live.next).toHaveBeenCalledTimes(1);
    const frozen = await call({ frozen: true });
    expect(frozen.out.statusCode).toBe(423);
    expect(frozen.next).not.toHaveBeenCalled();
  });

  test('an unauthenticated request is still a 401, and neither source is consulted', async () => {
    const calls = { wallet: 0, mark: 0 };
    const out = { statusCode: null };
    const res = {
      status(c) {
        out.statusCode = c;
        return this;
      },
      json() {
        return this;
      },
    };
    const next = jest.fn();
    await makeFrozenWalletGuard({
      findWallet: async () => {
        calls.wallet += 1;
        return { frozen: false };
      },
      readMark: async () => {
        calls.mark += 1;
        return LIVE_MARK;
      },
    })({ user: null }, res, next);
    expect(out.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(calls).toEqual({ wallet: 0, mark: 0 });
  });

  test('the mark is looked up for the SESSION user, never for a body field', async () => {
    const seen = [];
    const next = jest.fn();
    await makeFrozenWalletGuard({
      findWallet: async () => ({ frozen: false }),
      readMark: async (id) => {
        seen.push(id);
        return LIVE_MARK;
      },
    })(
      {
        user: { id: USER_ID },
        body: { userId: OTHER_ID },
        originalUrl: '/api/wallet/transfer',
      },
      {
        status() {
          return this;
        },
        json() {
          return this;
        },
      },
      next
    );
    expect(seen).toEqual([USER_ID]);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 3. THE WIRING - which no unit test of the middleware can prove
// ===========================================================================
//
// controllers/wallet.controller.js imports every coin gateway at module scope
// and cannot be pulled into a unit test, so the fact that the real guard is
// bound to BOTH sources is asserted against the controller source.

describe('the real guard is wired to both sources', () => {
  const CONTROLLER = fs.readFileSync(
    path.join(ROOT, 'controllers/wallet.controller.js'),
    'utf8'
  );

  test('blockFrozenWallet is built from the one factory that owns the decision', () => {
    expect(CONTROLLER).toMatch(/blockFrozenWallet\s*=\s*makeFrozenWalletGuard\(/);
  });

  test('it binds the wallet document as the authority', () => {
    expect(CONTROLLER).toMatch(
      /findWallet:\s*\(userId\)\s*=>\s*Wallet\.findById\(userId\)/
    );
  });

  test('THE FIX: it also binds the shared mark, so the default no-mark behaviour cannot become the production wiring', () => {
    expect(CONTROLLER).toMatch(
      /readMark:\s*\(userId\)\s*=>\s*readStandDownMark\(\{\s*hget\s*\}\,?\s*userId\)/
    );
    expect(CONTROLLER).toMatch(
      /import\s*\{[^}]*readStandDownMark[^}]*\}\s*from\s*["']\.\.\/lib\/walletStandDown\.js["']/
    );
  });

  test('only a redis READER is bound into it - no hset, no hdel, so this path cannot write the shared mark', () => {
    const binding = CONTROLLER.slice(
      CONTROLLER.indexOf('export const blockFrozenWallet'),
      CONTROLLER.indexOf('export const blockFrozenWallet') + 400
    );
    expect(binding).toContain('hget');
    expect(binding).not.toContain('hset');
    expect(binding).not.toContain('hdel');
    expect(binding).not.toContain('hincbyfloat');
  });
});

// ===========================================================================
// 4. THE ROUTES THE SECOND SOURCE NOW COVERS
// ===========================================================================

describe('the routes a mark-only stand-down now reaches', () => {
  const ROUTES = fs.readFileSync(path.join(ROOT, 'routes/wallet.route.js'), 'utf8');

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

  // The five custody routes this list used to name are DELETED - they moved
  // real money on a venue with no custody, and the operator approve/reject
  // workflow that completed them went with them. /transfer is the only
  // value-moving route left. A deleted route cannot lose a guard, so the
  // second block asserts they are gone from the router entirely.
  test.each([
    ['/transfer', 'post'],
  ])('POST %s is behind the two-source guard', (routePath, method) => {
    expect(chainFor(routePath, method)).toContain('walletCtrl.blockFrozenWallet');
  });

  test.each([
    '/coinWithdraw',
    '/coinWithdraw-app',
    '/fiatWithdraw',
    '/fiatDeposit',
    '/createAddress',
  ])('%s is not in the router at all', (routePath) => {
    const src = fs.readFileSync(path.join(ROOT, 'routes/wallet.route.js'), 'utf8');
    expect(src).not.toContain(`"${routePath}"`);
    expect(src).not.toContain(`'${routePath}'`);
  });

  // OVER-CORRECTION MUTANT: adding a second source must not turn read routes
  // into refusals. A stood-down account, and the operator restoring it, must
  // still be able to SEE the balances the freeze is preserving.
  test.each([
    ['/getAssetsDetails', 'get'],
    ['/history/transaction/:payment', 'get'],
  ])('GET %s is still NOT guarded', (routePath, method) => {
    const chain = chainFor(routePath, method);
    expect(chain).not.toBe(null);
    expect(chain).not.toContain('blockFrozenWallet');
  });
});
