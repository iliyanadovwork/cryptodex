/**
 * SPOT'S CLIENT FOR THE FREEZE AUTHORITY
 * ======================================
 *
 * walletapi's `wallet.frozen` is the authority on whether an account may move
 * value, and `deactivateWallet(mode: "check")` is its read-only preflight. This
 * client is how spot asks - the question spot never asked, which is why a
 * frozen wallet with a live session could keep trading here.
 *
 * WHAT THESE PIN
 * --------------
 *  - The call is READ-ONLY. `mode` is "check" and nothing else; a mutation of
 *    that literal to "freeze" would turn every order placement into an account
 *    closure, which is the worst thing this file could possibly do.
 *  - Every failure mode answers `known: false`, never `frozen: false` alone,
 *    because the caller turns UNKNOWN into a 503 refusal and would otherwise
 *    turn a walletapi restart into an open door.
 *  - It NEVER rejects. It sits in front of order placement; a rejection would
 *    become an unhandled rejection inside the guard.
 *  - The client is built LAZILY and a deadline is attached, so importing this
 *    module cannot fail under NODE_ENV=test (where GRPC_WALLET_URL is unset)
 *    and a walletapi that accepts connections without answering cannot hang the
 *    order path.
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';

let mockLastRequest = null;
let mockLastOptions = null;
let mockNextResponse = { status: true, message: 'READY' };
let mockNextError = null;
let mockClientConstructions = 0;
let mockLastTarget = 'unset';

let mockFromJSONCalls = [];

jest.mock('@grpc/grpc-js', () => ({
  __esModule: true,
  default: {
    loadPackageDefinition: () => ({
      Req: function Req(target) {
        mockClientConstructions += 1;
        mockLastTarget = target;
        this.deactivateWallet = (request, options, callback) => {
          mockLastRequest = request;
          mockLastOptions = options;
          if (mockNextError) return callback(mockNextError);
          return callback(null, mockNextResponse);
        };
      }
    }),
    credentials: { createInsecure: () => 'insecure' }
  }
}));

jest.mock('@grpc/proto-loader', () => ({
  __esModule: true,
  default: {
    fromJSON: (descriptor, options) => {
      mockFromJSONCalls.push({ descriptor, options });
      return {};
    },
    // Present so that a regression which goes back to reading a .proto off
    // disk - and therefore back to `import.meta.url`, which babel-jest cannot
    // evaluate - is caught here rather than crashing the whole suite.
    loadSync: () => {
      throw new Error('walletStandDownService must not read a proto from disk');
    }
  }
}));

import {
  WALLET_STAND_DOWN_DESCRIPTOR,
  checkWalletFrozen,
  __resetWalletStandDownClient,
} from '../../grpc/walletStandDownService.js';

const USER_ID = '6a70f1c287c92c7218ac37fc';

beforeEach(() => {
  mockLastRequest = null;
  mockLastOptions = null;
  mockNextResponse = { status: true, message: 'READY' };
  mockNextError = null;
  mockClientConstructions = 0;
  mockLastTarget = 'unset';
  mockFromJSONCalls = [];
  __resetWalletStandDownClient();
});

describe('checkWalletFrozen', () => {
  test('asks walletapi READ-ONLY, with mode "check" and nothing else', async () => {
    await checkWalletFrozen(USER_ID);
    expect(mockLastRequest).toEqual({ userId: USER_ID, mode: 'check' });
    expect(mockLastRequest.mode).not.toBe('freeze');
    expect(mockLastRequest.mode).not.toBe('unfreeze');
    expect(mockLastRequest.mode).not.toBe('teardown');
  });

  test('sends the user id as a string, so an ObjectId does not serialise to {}', async () => {
    await checkWalletFrozen({ toString: () => USER_ID });
    expect(mockLastRequest.userId).toBe(USER_ID);
  });

  test('ALREADY_FROZEN is frozen', async () => {
    mockNextResponse = { status: true, message: 'ALREADY_FROZEN' };
    expect(await checkWalletFrozen(USER_ID)).toEqual(
      expect.objectContaining({ known: true, frozen: true })
    );
  });

  test('READY is live', async () => {
    mockNextResponse = { status: true, message: 'READY' };
    expect(await checkWalletFrozen(USER_ID)).toEqual(
      expect.objectContaining({ known: true, frozen: false })
    );
  });

  test('NO_WALLET is live - a user with no wallet has no frozen wallet and no balance to move', async () => {
    mockNextResponse = { status: true, message: 'NO_WALLET' };
    expect(await checkWalletFrozen(USER_ID)).toEqual(
      expect.objectContaining({ known: true, frozen: false })
    );
  });

  test('a message walletapi has never sent is live, not frozen - only the one documented word means frozen', async () => {
    mockNextResponse = { status: true, message: 'SOMETHING_ELSE' };
    expect(await checkWalletFrozen(USER_ID)).toEqual(
      expect.objectContaining({ known: true, frozen: false })
    );
  });

  test('status:false is UNKNOWN, not live', async () => {
    mockNextResponse = { status: false, message: 'INVALID_USER_ID' };
    const verdict = await checkWalletFrozen(USER_ID);
    expect(verdict.known).toBe(false);
    expect(verdict.frozen).toBe(false);
  });

  test('an empty reply is UNKNOWN, not live', async () => {
    mockNextResponse = null;
    expect((await checkWalletFrozen(USER_ID)).known).toBe(false);
  });

  test('a transport error is UNKNOWN, not live, and does not reject', async () => {
    mockNextError = new Error('14 UNAVAILABLE');
    await expect(checkWalletFrozen(USER_ID)).resolves.toEqual(
      expect.objectContaining({ known: false, frozen: false })
    );
  });

  test('a DEADLINE is attached, so a walletapi that never answers cannot hang the order path', async () => {
    const before = Date.now();
    await checkWalletFrozen(USER_ID);
    expect(mockLastOptions).toBeTruthy();
    expect(mockLastOptions.deadline instanceof Date).toBe(true);
    const ms = mockLastOptions.deadline.getTime() - before;
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(5000);
  });

  test('the client is built once and reused, and only on first USE - importing this module must not construct it', async () => {
    expect(mockClientConstructions).toBe(0);
    await checkWalletFrozen(USER_ID);
    await checkWalletFrozen(USER_ID);
    expect(mockClientConstructions).toBe(1);
    __resetWalletStandDownClient();
    await checkWalletFrozen(USER_ID);
    expect(mockClientConstructions).toBe(2);
  });

  test('it dials the WALLET target, not this service\'s own gRPC port', async () => {
    await checkWalletFrozen(USER_ID);
    const src = fs.readFileSync(
      path.join(process.cwd(), 'grpc', 'walletStandDownService.js'),
      'utf8'
    );
    expect(src).toContain('config.GRPC.WALLET_URL');
    expect(src).not.toContain('config.GRPC.URL');
  });
});

describe('the wire contract this client speaks', () => {
  test('declares only deactivateWallet - a client contract must not widen what this service advertises', () => {
    expect(Object.keys(WALLET_STAND_DOWN_DESCRIPTOR.nested.Req.methods)).toEqual([
      'deactivateWallet'
    ]);
  });

  test('its field numbers match walletapi/grpc/wallet.proto, because gRPC decodes by TAG and not by name', () => {
    const { deactivateWalletReq, deactivateWalletRes } =
      WALLET_STAND_DOWN_DESCRIPTOR.nested;
    expect(deactivateWalletReq.fields).toEqual({
      userId: { type: 'string', id: 1 },
      mode: { type: 'string', id: 2 }
    });
    expect(deactivateWalletRes.fields).toEqual({
      status: { type: 'bool', id: 1 },
      message: { type: 'string', id: 2 }
    });
  });

  test('the service is named Req and the method deactivateWallet, because gRPC dispatches on /Req/deactivateWallet', () => {
    expect(WALLET_STAND_DOWN_DESCRIPTOR.nested.Req.methods.deactivateWallet).toEqual({
      requestType: 'deactivateWalletReq',
      responseType: 'deactivateWalletRes'
    });
  });

  test('the descriptor is loaded in place, with keepCase so userId does not become user_id on the wire', async () => {
    await checkWalletFrozen(USER_ID);
    expect(mockFromJSONCalls).toHaveLength(1);
    expect(mockFromJSONCalls[0].descriptor).toBe(WALLET_STAND_DOWN_DESCRIPTOR);
    expect(mockFromJSONCalls[0].options).toEqual(
      expect.objectContaining({ keepCase: true })
    );
  });

  test('it is NOT registered on this service\'s own gRPC server', () => {
    const server = fs.readFileSync(path.join(process.cwd(), 'grpc', 'server.js'), 'utf8');
    expect(server).not.toContain('walletStandDown');
    expect(server).not.toContain('deactivateWallet');
  });
});
