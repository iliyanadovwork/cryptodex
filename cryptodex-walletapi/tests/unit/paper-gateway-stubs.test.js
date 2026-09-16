/**
 * Paper Trading — Coin Gateway Stub Contract Tests
 *
 * The paper-trading conversion replaced every coin gateway
 * (controllers/coin/*Gateway.js) with an offline stub. These tests pin the
 * module contract the rest of the service depends on:
 *
 *  1. Every export name a live importer uses still exists
 *     (coin.controller.js, controllers/wallet.js and wallet.controller.js
 *     import these at boot — a missing name crashes the gRPC server).
 *  2. Money-moving functions resolve to { status: true, trxId: "paper-..." }.
 *  3. createAddress returns paper addresses (never a real chain address).
 *  4. No live chain libraries (web3 / tronweb / bitcoin / fireblocks / ...)
 *     are imported — nothing can perform network I/O.
 */

import { describe, test, expect, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';

import * as bdyxGateway from '../../controllers/coin/bdyxGateway.js';
import * as bnbGateway from '../../controllers/coin/bnbGateway.js';
import * as btcGateway from '../../controllers/coin/btcGateway.js';
import * as ethGateway from '../../controllers/coin/ethGateway.js';
import * as ltcGateway from '../../controllers/coin/ltcGateway.js';
import * as polyGateway from '../../controllers/coin/polyGateway.js';
import * as trxGateway from '../../controllers/coin/trxGateway.js';
import * as firebaseStub from '../../controllers/coin/firebase.js';

const COIN_DIR = path.join(__dirname, '../../controllers/coin');

const PAPER_TRXID_REGEX = /^paper-\d+$/;

/**
 * Contract table.
 * - requiredByImporters: names actually referenced by live importers
 *   (controllers/coin.controller.js, controllers/wallet.js,
 *   controllers/wallet.controller.js).
 * - transferFns: on-chain send/sweep functions — must resolve to
 *   { status: true, trxId: /^paper-\d+$/ }.
 * - noopFns: deposit-scan / cron functions — must resolve truthy without I/O.
 */
const GATEWAYS = [
  {
    name: 'btcGateway',
    file: 'btcGateway.js',
    mod: btcGateway,
    addressPrefix: 'paper-btc-',
    requiredByImporters: ['createAddress', 'deposit'],
    transferFns: ['transfer'],
    noopFns: ['deposit'],
  },
  {
    name: 'ltcGateway',
    file: 'ltcGateway.js',
    mod: ltcGateway,
    addressPrefix: 'paper-ltc-',
    requiredByImporters: ['createAddress', 'deposit'],
    transferFns: ['transfer'],
    noopFns: ['deposit'],
  },
  {
    name: 'ethGateway',
    file: 'ethGateway.js',
    mod: ethGateway,
    addressPrefix: 'paper-eth-',
    requiredByImporters: ['createAddress', 'deposit', 'tokenDeposit'],
    transferFns: [
      'amountMoveToAdmin',
      'tokenMoveToAdmin_new',
      'amountMoveToUser',
      'tokenMoveToUser_new',
      'ethMovetoAdmin',
      'tokenMoveToAdmin',
      'tokenMoveToUser',
      'ethMovetoUser',
    ],
    noopFns: [
      'deposit',
      'tokenDeposit',
      'ethMovetoAdminCron',
      'erc20MoveToAdminCron',
      'ethMovetoAdminCron_new',
    ],
  },
  {
    name: 'bnbGateway',
    file: 'bnbGateway.js',
    mod: bnbGateway,
    addressPrefix: 'paper-bnb-',
    requiredByImporters: [
      'createAddress',
      'deposit',
      'tokenDeposit',
      'getTokenBalance',
      'getCryptoBalance',
    ],
    transferFns: [
      'bnbMovetoAdmin',
      'bnbMovetoUser',
      'tokenMoveToAdmin',
      'tokenMoveToUser',
    ],
    noopFns: ['deposit', 'tokenDeposit', 'bep20MoveToAdminCron'],
  },
  {
    name: 'bdyxGateway',
    file: 'bdyxGateway.js',
    mod: bdyxGateway,
    addressPrefix: 'paper-bdyx-',
    requiredByImporters: ['createAddress'],
    transferFns: [
      'bdyxMovetoAdmin',
      'bdyxMovetoUser',
      'tokenMoveToAdmin',
      'tokenMoveToUser',
    ],
    noopFns: ['deposit', 'tokenDeposit', 'bep20MoveToAdminCron'],
  },
  {
    name: 'polyGateway',
    file: 'polyGateway.js',
    mod: polyGateway,
    addressPrefix: 'paper-poly-',
    requiredByImporters: ['createAddress', 'polyCoinDeposit', 'polytokenDeposit'],
    transferFns: [
      'ployCoinMovetoAdmin',
      'tokenMoveToAdmin',
      'polyCoinMovetoUser',
      'tokenMoveToUser',
    ],
    noopFns: [
      'polyCoinDeposit',
      'polytokenDeposit',
      'polyCoinDepositCron',
      'polyTokenDepositCron',
    ],
  },
  {
    name: 'trxGateway',
    file: 'trxGateway.js',
    mod: trxGateway,
    addressPrefix: 'paper-trx-',
    requiredByImporters: ['createAddress'],
    transferFns: [
      'sentTransaction',
      'tokenMoveToUser',
      'Trc20TokenMoveToAdmin',
      'NewAmountMoveToUser',
      'NewSendToken',
      'amountMoveToAdmin',
      'tokenMoveToAdmin',
    ],
    noopFns: [
      'tronDeposit',
      'tronTokenDeposit',
      'AmountMoveToAdmin',
      'deposit',
      'trxMovetoAdminCron_new',
    ],
  },
];

describe('Paper Trading Gateway Stubs (module contract)', () => {
  describe.each(GATEWAYS)('$name', ({ mod, addressPrefix, requiredByImporters, transferFns, noopFns }) => {
    test('exports every name its live importers use, as functions', () => {
      for (const name of requiredByImporters) {
        expect(typeof mod[name]).toBe('function');
      }
    });

    test('createAddress returns a paper address with an empty private key', async () => {
      const result = await mod.createAddress({ userId: 'test-user' });

      expect(result).toBeTruthy();
      expect(typeof result.address).toBe('string');
      expect(result.address.startsWith(addressPrefix)).toBe(true);
      expect(result.privateKey).toBe('');
    });

    test('createAddress produces unique addresses per call', async () => {
      const a = await mod.createAddress({ userId: 'user-a' });
      const b = await mod.createAddress({ userId: 'user-b' });

      expect(a.address).not.toBe(b.address);
    });

    test('transfer/move functions resolve to { status: true, trxId: paper-<ts> }', async () => {
      for (const fnName of transferFns) {
        expect(typeof mod[fnName]).toBe('function');
        const result = await mod[fnName]({ amount: 1, userAddress: 'paper-x' });

        expect(result).toEqual({
          status: true,
          trxId: expect.stringMatching(PAPER_TRXID_REGEX),
        });
      }
    });

    test('deposit-scan and sweep-cron functions resolve without doing anything', async () => {
      for (const fnName of noopFns) {
        expect(typeof mod[fnName]).toBe('function');
        await expect(mod[fnName]()).resolves.toBe(true);
      }
    });

    test('isAddress accepts any non-empty string and rejects empty input', () => {
      expect(mod.isAddress('paper-anything')).toBe(true);
      expect(mod.isAddress('')).toBe(false);
      expect(mod.isAddress(undefined)).toBe(false);
    });
  });

  describe('no live chain libraries are imported by any gateway stub', () => {
    const BANNED_SPECIFIER =
      /(web3|tronweb|bitcoin|bitcore|ethereumjs|eth-lib|fireblocks|bip39|hex2dec|axios)/i;

    const gatewayFiles = fs
      .readdirSync(COIN_DIR)
      .filter((f) => f.endsWith('Gateway.js'))
      .concat(['firebase.js']);

    test('the seven gateway stubs are all present on disk', () => {
      expect(gatewayFiles.sort()).toEqual(
        [
          'bdyxGateway.js',
          'bnbGateway.js',
          'btcGateway.js',
          'ethGateway.js',
          'firebase.js',
          'ltcGateway.js',
          'polyGateway.js',
          'trxGateway.js',
        ].sort()
      );
    });

    test.each(gatewayFiles.map((f) => [f]))(
      '%s imports no web3/tronweb/bitcoin/fireblocks modules',
      (file) => {
        const source = fs.readFileSync(path.join(COIN_DIR, file), 'utf8');

        // Collect every module specifier referenced by the file.
        const specifiers = [];
        const importRegex =
          /(?:from\s+|require\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
        let match;
        while ((match = importRegex.exec(source)) !== null) {
          specifiers.push(match[1]);
        }

        const banned = specifiers.filter((s) => BANNED_SPECIFIER.test(s));
        expect(banned).toEqual([]);

        // Belt and braces: no live SDK construction survives in the stubs.
        expect(source).not.toMatch(/new\s+Web3\s*\(/);
        expect(source).not.toMatch(/new\s+TronWeb\s*\(/);
        expect(source).not.toMatch(/new\s+FireblocksSDK\s*\(/);
      }
    );
  });

  describe('firebase.js (Fireblocks stub)', () => {
    test('exports every name its live importers use, as functions', () => {
      // wallet.controller.js, controllers/wallet.js, currency.controller.js
      const required = [
        'getClientAccountDetails',
        'getInternalWallets',
        'createVaultAsset',
        'getUserWalletById',
        'getAssets',
      ];
      for (const name of required) {
        expect(typeof firebaseStub[name]).toBe('function');
      }
    });

    test('collection-shaped results keep the shapes callers iterate', async () => {
      // Callers iterate `.assets` / call .find / .findIndex on these.
      await expect(firebaseStub.getClientAccountDetails()).resolves.toEqual({
        assets: [],
      });
      await expect(firebaseStub.getInternalWallets()).resolves.toEqual([]);
      await expect(firebaseStub.getAssets()).resolves.toEqual([]);
    });

    test('custody operations are refused instead of executed', async () => {
      await expect(firebaseStub.createVaultForUser({})).resolves.toBe(false);
      await expect(firebaseStub.createTransaction({})).resolves.toBe(false);
      await expect(firebaseStub.createVaultAsset('v', 'a')).resolves.toEqual({
        status: false,
        error: expect.stringMatching(/paper trading/i),
      });
    });

    test('webhook endpoint answers without processing deposits', async () => {
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };
      await firebaseStub.fireblocksPOST({}, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true })
      );
    });
  });
});
