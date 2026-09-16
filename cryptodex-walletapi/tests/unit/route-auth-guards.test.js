/**
 * Route auth guards + secret-hygiene regression tests (Wallet API)
 *
 * Fixes these pin:
 *
 *  1. GET  /api/admin/getUserAsset       had NO auth middleware. It takes a
 *     userId straight off the query string and returns that user's balances
 *     and deposit addresses -> unauthenticated enumeration of every account.
 *  2. GET  /api/admin/getAdminBal        had NO auth  -> treasury address+balance.
 *  3. GET  /api/admin/get-admin-asset    had NO auth  -> site-wide cumulative funds.
 *  4. GET  /api/admin/setup-gas-station  had NO auth  -> and it runs
 *     GasStation.deleteMany({}) before rebuilding, i.e. an unauthenticated wipe.
 *  5. POST /api/wallet/testRoute         unauthenticated debug endpoint.
 *  6. config/passport.js logged the JWT signing key prefix at boot AND dumped
 *     the whole Redis "userToken" record - which contains secret2FA, the user's
 *     TOTP seed - on every authenticated request.
 *  7. The gRPC wallet service returned assets[].privateKey to its callers over
 *     a plaintext channel, and createAddress returned the unprojected wallet
 *     document (privateKey included) over HTTP.
 *
 * The route tests mount the REAL route modules behind a stub passport whose
 * "adminAuth"/"usersAuth" strategies always reject, then assert 401. A handler
 * that is reachable without the guard answers 200/4xx-from-the-controller
 * instead, so a dropped middleware fails loudly rather than silently.
 */

import { describe, test, expect, beforeAll, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';

const ROOT = path.join(__dirname, '../..');

// ---------------------------------------------------------------------------
// Stubs. Every controller module a route file imports is replaced by a Proxy
// that yields an "I ran" handler for any export name, so reaching a controller
// is unambiguous: 200 + { reachedController: true }.
// ---------------------------------------------------------------------------
const REACHED = { reachedController: true };

const controllerStub = () =>
  new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === '__esModule') return true;
        if (typeof prop !== 'string') return undefined;
        // multer-style upload middlewares are used as `ctrl.upload.single(...)`
        const fn = (req, res, next) =>
          typeof next === 'function' && res === undefined ? next() : res.status(200).json(REACHED);
        fn.single = () => (req, res, next) => next();
        fn.fields = () => (req, res, next) => next();
        return fn;
      },
    }
  );

const validationStub = () =>
  new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === '__esModule') return true;
        if (typeof prop !== 'string') return undefined;
        return (req, res, next) => next();
      },
    }
  );

jest.mock('../../controllers/wallet.controller.js', () => controllerStub());
jest.mock('../../controllers/currency.controller.js', () => controllerStub());
jest.mock('../../controllers/priceCNV.controller.js', () => controllerStub());
jest.mock('../../controllers/passbook.controller.js', () => controllerStub());
jest.mock('../../controllers/coin/firebase.js', () => controllerStub());
jest.mock('../../validation/currency.validation.js', () => validationStub());
jest.mock('../../validation/priceCNV.validation.js', () => validationStub());
jest.mock('../../validation/wallet.validation.js', () => validationStub());
jest.mock('../../validation/date.validation.js', () => validationStub());

/** Passport whose every strategy rejects, so an guarded route must 401. */
jest.mock('passport', () => {
  const denyAll = () => (req, res) =>
    res.status(401).json({ success: false, message: 'Unauthorized' });
  return {
    __esModule: true,
    default: { authenticate: denyAll, initialize: () => (req, res, next) => next() },
    authenticate: denyAll,
    initialize: () => (req, res, next) => next(),
  };
});

let adminRoute;
let walletRoute;
let app;

beforeAll(async () => {
  walletRoute = (await import('../../routes/wallet.route.js')).default;

  app = express();
  app.use(express.json());
  // NOTHING is mounted at /api/admin. The router file is gone; see the block
  // below, which asserts that rather than importing it.
  app.use('/api/wallet', walletRoute);
});

// ---------------------------------------------------------------------------

describe('the admin surface is gone, file and mount', () => {
  /**
   * This suite used to mount routes/admin.route.js behind a rejecting passport
   * and assert 401 on the four routes that shipped with NO guard at all -
   * `getUserAsset` (any user's balances and deposit addresses by query string),
   * `getAdminBal` (treasury address and balance), `get-admin-asset` (site-wide
   * cumulative funds) and `setup-gas-station` (which runs
   * `GasStation.deleteMany({})` before rebuilding, i.e. an unauthenticated
   * wipe).
   *
   * All four are now DELETED rather than guarded, which is the stronger answer.
   * The last of them went with custody: coin and fiat withdrawal approve/reject
   * and the gas station were an operator workflow on a venue that holds no
   * custody.
   *
   * A test that imports the router to prove the router is gone cannot pass, so
   * absence is asserted at the three levels that can actually hold it: the file
   * does not exist, the server does not mount it, and no admin strategy is
   * registered to authenticate one.
   */
  const ROOT = path.join(__dirname, '..', '..');

  test('routes/admin.route.js does not exist', () => {
    expect(fs.existsSync(path.join(ROOT, 'routes/admin.route.js'))).toBe(false);
  });

  test('server.js mounts nothing at /api/admin', () => {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    expect(server).not.toMatch(/admin\.route/);
    expect(server).not.toMatch(/['"]\/api\/admin['"]/);
  });

  test('no adminAuth strategy is registered, and fetchAdmin is not dialled', () => {
    const passportSrc = fs.readFileSync(path.join(ROOT, 'config/passport.js'), 'utf8');
    expect(passportSrc).not.toMatch(/passport\.use\(\s*["']adminAuth["']/);
    expect(passportSrc).not.toMatch(/fetchAdmin/.source ? /import .*fetchAdmin/ : /fetchAdmin/);
    expect(fs.existsSync(path.join(ROOT, 'grpc/adminService.js'))).toBe(false);
  });

  test('an /api/admin request reaches nothing', async () => {
    for (const url of [
      '/api/admin/getUserAsset?userId=000000000000000000000000',
      '/api/admin/getAdminBal',
      '/api/admin/setup-gas-station',
      '/api/admin/coinWithdraw/reject',
    ]) {
      const res = await request(app).get(url);
      expect(res.status).toBe(404);
      expect(res.body).not.toEqual(REACHED);
    }
  });
});

describe('custody is gone from the wallet router too', () => {
  const CUSTODY = [
    ['post', '/api/wallet/fiatDeposit'],
    ['post', '/api/wallet/coinWithdraw'],
    ['post', '/api/wallet/coinWithdraw-app'],
    ['post', '/api/wallet/fiatWithdraw'],
    ['get', '/api/wallet/userDeposit'],
    ['get', '/api/wallet/getWithdrawLimit'],
    ['post', '/api/wallet/createAddress'],
    ['post', '/api/wallet/fireblocksWebhook'],
  ];

  test.each(CUSTODY)('%s %s is not mounted', async (method, url) => {
    const res = await request(app)[method](url);
    expect(res.status).toBe(404);
    expect(res.body).not.toEqual(REACHED);
  });
});

describe('Wallet API user routes', () => {
  test('POST /api/wallet/testRoute (unauthenticated debug endpoint) is gone', async () => {
    const res = await request(app).post('/api/wallet/testRoute');
    expect(res.status).toBe(404);
  });

  // `createAddress` generated a blockchain deposit address. Deleted with
  // custody, and its absence is asserted in the custody block above.

  test('getAssetsDetails still requires a user token', async () => {
    const res = await request(app).get('/api/wallet/getAssetsDetails');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Secret hygiene. Source-level assertions: these are things that must not be
// written, and there is no runtime hook that would catch them being re-added.
// ---------------------------------------------------------------------------

describe('no secret material is logged or returned', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  test('config/passport.js never logs the JWT signing key', () => {
    const src = read('config/passport.js');
    const logsSecret = src
      .split('\n')
      .filter((l) => /console\.(log|info|warn|error|debug)/.test(l))
      .filter((l) => /secretOrKey|opts\.secret/.test(l));
    expect(logsSecret).toEqual([]);
  });

  test('config/passport.js never logs the Redis userToken record (carries secret2FA)', () => {
    const src = read('config/passport.js');
    const logsUserDoc = src
      .split('\n')
      .filter((l) => /console\.(log|info|warn|error|debug)/.test(l))
      .filter((l) => /userDoc|secret2FA|payload\b|tokenId/.test(l));
    expect(logsUserDoc).toEqual([]);
  });

  test('routes/wallet.route.js has no module-level console.log', () => {
    const src = read('routes/wallet.route.js');
    // Route files should only register routes; a top-level log ran at boot and
    // printed the whole controller surface.
    const topLevelLogs = src
      .split('\n')
      .filter((l) => /^console\.(log|info|warn|error|debug)\(/.test(l.trim()));
    expect(topLevelLogs).toEqual([]);
  });

  test('gRPC wallet service does not return assets[].privateKey', async () => {
    const src = read('controllers/wallet.js');
    const getUserAssetBody = src.slice(
      src.indexOf('export const getUserAsset'),
      src.indexOf('export const updateUserAsset')
    );
    expect(getUserAssetBody).not.toMatch(/^\s*privateKey:/m);
  });

  test('createAddress returns a projected wallet, never the raw document', () => {
    const src = read('controllers/wallet.controller.js');
    // `export const updateAsset` used to terminate this slice; it has been
    // deleted with the admin surface, and indexOf would return -1 and produce
    // an empty slice that trivially "passes". Anchor on the next surviving
    // export instead.
    const startIdx = src.indexOf('export const createAddress');
    expect(startIdx).toBeGreaterThan(-1);
    const endIdx = src.indexOf('export const', startIdx + 'export const createAddress'.length);
    expect(endIdx).toBeGreaterThan(startIdx);
    const body = src.slice(startIdx, endIdx);
    // The refresh read that feeds `data: wallet` must carry a projection.
    const refresh = body.slice(body.lastIndexOf('Wallet.findById(userid'));
    expect(refresh).toMatch(/"assets\.coin": 1/);
    expect(refresh).not.toMatch(/privateKey/);
  });
});
