/**
 * LTC Gateway — PAPER TRADING STUB
 *
 * All on-chain operations are neutralized: no node RPC, no chain libs.
 * Every original export is preserved so the module stays resolvable —
 * grpc/server.js -> createAsset.js -> coin.controller.js imports this file at
 * boot, and deleting/renaming exports would crash the walletapi gRPC server.
 */

const paperAddress = () =>
  "paper-ltc-" +
  Date.now().toString(16) +
  Math.random().toString(16).slice(2, 10);

/**
 * BODY : userId
 */
export const createAddress = async (data) => {
  return {
    address: paperAddress(),
    privateKey: "",
  };
};

export const deposit = async () => {
  // Paper trading: on-chain deposit scanning disabled
  return true;
};

/**
 * Transfer amount
 * BODY : amount, userAddress
 */
export const transfer = async ({ userAddress, amount } = {}) => {
  return {
    status: true,
    trxId: `paper-${Date.now()}`,
  };
};

export const isAddress = (address) => {
  return typeof address === "string" && address.length > 0;
};

export const getBalance = async () => {
  return 0;
};
