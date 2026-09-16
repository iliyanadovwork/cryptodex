/**
 * TRX Gateway — PAPER TRADING STUB
 *
 * All on-chain operations are neutralized: no TronWeb, no chain RPC, no key
 * usage. Every original export is preserved so the module stays resolvable —
 * deleting/renaming exports could crash importers at boot.
 */

const paperAddress = () =>
  "paper-trx-" +
  Date.now().toString(16) +
  Math.random().toString(16).slice(2, 10);

const paperTrxId = () => `paper-${Date.now()}`;

export const createAddress = async () => {
  return {
    address: paperAddress(),
    privateKey: "",
  };
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

export const tronDeposit = async (userId) => {
  // Paper trading: on-chain deposit scanning disabled
  return true;
};

export const tronTokenDeposit = async (userId, currencySymbol) => {
  // Paper trading: on-chain deposit scanning disabled
  return true;
};

export const sentTransaction = async (data) => {
  return { status: true, trxId: paperTrxId() };
};

export const tokenMoveToUser = async (data) => {
  return { status: true, trxId: paperTrxId() };
};

export const isAddress = (address) => {
  return typeof address === "string" && address.length > 0;
};

export const AmountMoveToAdmin = async () => {
  // Paper trading: sweep disabled
  return true;
};

export const getContractBalance = async (data) => {
  return 0;
};

export const deposit = async () => {
  // Paper trading: on-chain deposit scanning disabled
  return true;
};

export const Trc20TokenMoveToAdmin = async (data) => {
  return { status: true, trxId: paperTrxId() };
};

export const NewAmountMoveToUser = async (data) => {
  return { status: true, trxId: paperTrxId() };
};

export const NewSendToken = async (data) => {
  return { status: true, trxId: paperTrxId() };
};

export const amountMoveToAdmin = async (data) => {
  return { status: true, trxId: paperTrxId() };
};

export const tokenMoveToAdmin = async (data) => {
  return { status: true, trxId: paperTrxId() };
};

export const DepositWebhook = async (req, res) => {
  return res
    .status(200)
    .json({ success: true, message: "Paper trading mode - deposits disabled" });
};

export const trxMovetoAdminCron_new = async () => {
  // Paper trading: sweep cron disabled
  return true;
};
