/**
 * NO CHAIN RPC FROM THE WALLET API (paper trading)
 *
 * controllers/dashboard.controller.js was the last live-chain path left in the
 * service. Five private helpers behind GET /api/admin/getAdminBal
 * (routes/admin.route.js -> dashboardCtrl.getAdminBal, admin-authenticated but
 * very much reachable) each opened a Web3 HTTP provider and made a real
 * eth_getBalance / balanceOf call:
 *
 *   cryptoEthereum -> https://goerli.infura.io/v3/...    (dead testnet)
 *   ERC20_Token    -> https://ropsten.infura.io/v3/...   (dead testnet)
 *   cryptoBinance / cryptoMatic / BEP20_Token -> config.COIN_GATE_WAY.*.URL
 *
 * Goerli and Ropsten are both shut down, so the treasury read sat on a hanging
 * socket until the provider gave up and the catch swallowed it. Nothing in a
 * paper-trading stack has custody - every
 * controllers/coin/*Gateway.js is already an offline stub minting `paper-*`
 * addresses - so these are now stubs too, in the same style: no web3 import,
 * no RPC, zero balances, original return shapes preserved.
 *
 * These tests pin (a) the source can no longer construct a chain client, and
 * (b) getAdminBal still answers with every configured coin, at zero.
 */

import { describe, test, expect, beforeAll, beforeEach, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '../..');
const DASHBOARD = path.join(ROOT, 'controllers/dashboard.controller.js');

// ---------------------------------------------------------------------------
// Static: the module cannot dial a chain even if someone calls it.
// ---------------------------------------------------------------------------
describe('the dashboard controller is gone entirely', () => {
  test('controllers/dashboard.controller.js does not exist', () => {
    // This block used to assert the controller contained no live-chain path.
    // The whole controller is deleted: it served /TotalBalance,
    // /TotalBalanceChart, /AssetsAllocation, /profitLoss and /getDashBal -
    // portfolio analytics for a dashboard page this venue does not have. Each
    // had a service wrapper in the frontend and zero components rendering it.
    // Absence is a stronger guarantee than "contains no chain call".
    expect(fs.existsSync(path.join(ROOT, 'controllers/dashboard.controller.js'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'routes/dashboard.route.js'))).toBe(false);
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    expect(server).not.toMatch(/dashboard\.route/);
  });
});

/**
 * Repo-wide: no live source file may hardcode a dead-testnet RPC URL. The
 * config block still carries COIN_GATE_WAY entries - those are deployment
 * data, not a call - so this scans for
 * literal endpoint strings in controllers/, grpc/ and lib/ only.
 */
describe('no controller hardcodes a chain RPC endpoint', () => {
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith('.js') ? [full] : [];
    });
  };

  const files = ['controllers', 'grpc', 'lib'].flatMap((d) =>
    walk(path.join(ROOT, d))
  );

  test('there are source files to scan (guards against a silent empty pass)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  test('none of them contains an infura.io URL', () => {
    const offenders = files.filter((file) => {
      const codeOnly = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      return /https?:\/\/[^\s'"]*infura\.io/i.test(codeOnly);
    });

    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getAdminBal is GONE, which settles the question more firmly than stubbing it.
// ---------------------------------------------------------------------------
//
// The functional half of this file used to call getAdminBal and assert it
// answered 200 with every configured coin at zero, inside a 1s budget, so that
// a reintroduced RPC would show up as a hang. The endpoint it backed
// (GET /api/admin/getAdminBal) has been removed with the admin surface, and the
// five chain-balance helpers went with it.
//
// The static checks above are the part that still matters and they now cover
// the whole service, not just this one endpoint: no chain SDK is imported, no
// Web3 provider is constructed, and no infura URL appears in any controller.
describe('the admin treasury endpoint is removed', () => {
  test('the whole dashboard controller is gone, so no treasury path can survive in it', () => {
    // This block used to read controllers/dashboard.controller.js and assert it
    // contained no chain RPC, no Web3 provider and no infura URL. The file no
    // longer exists - it went with the /api/dashboard router (TotalBalance,
    // TotalBalanceChart, AssetsAllocation, profitLoss) and /getDashBal, all of
    // which were portfolio analytics with no page rendering them. Nothing can
    // hide in a file that is not there.
    expect(fs.existsSync(DASHBOARD)).toBe(false);
  });
});
