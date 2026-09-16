/**
 * POLYGON Gateway — PAPER TRADING STUB
 *
 * All on-chain operations are neutralized: no web3, no chain RPC, no key usage.
 * Every original export is preserved so the module stays resolvable —
 * grpc/server.js -> createAsset.js -> coin.controller.js imports this file at
 * boot, and deleting/renaming exports would crash the walletapi gRPC server.
 */

const paperAddress = () =>
  "paper-poly-" +
  Date.now().toString(16) +
  Math.random().toString(16).slice(2, 10);

const paperTrxId = () => `paper-${Date.now()}`;

export const createAddress = async () => {
  return {
    status: true,
    address: paperAddress(),
    privateKey: "",
  };
};

/* Check Valid Is Address */
export const isAddress = (address) => {
  return typeof address === "string" && address.length > 0;
};

export const polyCoinDeposit = async (userId, currencyId) => {
  // Paper trading: on-chain deposit scanning disabled
  return true;
};

export const polytokenDeposit = async (userId, currencySymbol) => {
  // Paper trading: on-chain deposit scanning disabled
  return true;
};

export const polyCoinDepositCron = async () => {
  // Paper trading: deposit cron disabled
  return true;
};

export const ployCoinMovetoAdmin = async (data) => {
  return { status: true, trxId: paperTrxId() };
};

export const polyTokenDepositCron = async () => {
  // Paper trading: sweep cron disabled
  return true;
};

export const tokenMoveToAdmin = async (data) => {
  return { status: true, trxId: paperTrxId() };
};

export const polyCoinMovetoUser = async (data) => {
  return { status: true, trxId: paperTrxId() };
};

export const tokenMoveToUser = async (data) => {
  return { status: true, trxId: paperTrxId() };
};
