/**
 * BNB Gateway — PAPER TRADING STUB
 *
 * All on-chain operations are neutralized: no web3, no chain RPC, no key usage.
 * Every original export is preserved so the module stays resolvable —
 * grpc/server.js -> createAsset.js -> coin.controller.js imports this file at
 * boot, and deleting/renaming exports would crash the walletapi gRPC server.
 */

const paperAddress = () =>
  "paper-bnb-" +
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

export const getCryptoBalance = async (address) => {
  return { status: true, balance: 0 };
};

export const getTokenBalance = async (contractAddress, walletAddress) => {
  return { status: true, balance: 0 };
};

export function convert(n) {
  try {
    var sign = +n < 0 ? "-" : "",
      toStr = n.toString();
    if (!/e/i.test(toStr)) {
      return n;
    }
    var [lead, decimal, pow] = n
      .toString()
      .replace(/^-/, "")
      .replace(/^([0-9]+)(e.*)/, "$1.$2")
      .split(/e|\./);
    return +pow < 0
      ? sign +
          "0." +
          "0".repeat(Math.max(Math.abs(pow) - 1 || 0, 0)) +
          lead +
          decimal
      : sign +
          lead +
          (+pow >= decimal.length
            ? decimal + "0".repeat(Math.max(+pow - decimal.length || 0, 0))
            : decimal.slice(0, +pow) + "." + decimal.slice(+pow));
  } catch (err) {
    return 0;
  }
}

export const deposit = async (userId, currencyId) => {
  // Paper trading: on-chain deposit scanning disabled
  return true;
};

export const bnbMovetoAdmin = async (data) => {
  return { status: true, trxId: paperTrxId() };
};

export const bnbMovetoUser = async (data) => {
  return { status: true, trxId: paperTrxId() };
};

export const tokenDeposit = async (userId, currencySymbol) => {
  // Paper trading: on-chain deposit scanning disabled
  return true;
};

export const tokenMoveToAdmin = async (data) => {
  return { status: true, trxId: paperTrxId() };
};

export const tokenMoveToUser = async (data) => {
  return { status: true, trxId: paperTrxId() };
};

export const isAddress = (address) => {
  return typeof address === "string" && address.length > 0;
};

export const bep20MoveToAdminCron = async () => {
  // Paper trading: sweep cron disabled
  return true;
};
