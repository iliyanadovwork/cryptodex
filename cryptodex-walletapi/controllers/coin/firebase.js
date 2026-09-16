/**
 * Fireblocks integration — PAPER TRADING STUB
 *
 * The FireblocksSDK constructor and the module-load reads of
 * demo_secret.key / prod_secret.key / fireblocks_signature.key are removed:
 * this file is imported at module load by wallet.controller.js, wallet.js and
 * currency.controller.js (all on the gRPC server boot chain), so it must stay
 * loadable without any custody credentials. Every original export is
 * preserved; bodies return paper-mode/no-op results.
 */

export const createVaultForUser = async (user) => {
  // Paper trading: no custody vaults
  return false;
};

export const createVaultForPayment = async (paymentId) => {
  // Paper trading: no custody vaults
  return false;
};

export const getUserWalletById = async (id) => {
  return false;
};

export const getClientAccountDetails = async () => {
  // Callers iterate `.assets` — return an empty asset list
  return { assets: [] };
};

export const getSeparateAcc = async (id, gatewaycode) => {
  return null;
};

export const createVaultAsset = async (vaultId, assetId) => {
  return { status: false, error: "Disabled in paper trading mode" };
};

export const getVaultAsset = async (vaultId, assetId) => {
  return false;
};

export const activateVaultAsset = async (vaultId, assetId) => {
  return false;
};

export const generateNewAddress = async (vaultId, assetId) => {
  return false;
};

export const getAssets = async () => {
  // Callers call findIndex on the result — return an empty list
  return [];
};

export const getAssetFee = async (asset) => {
  return false;
};

export const failedTransactions = async () => {
  return false;
};

export const failedTransactionsById = async (txId) => {
  return false;
};

export const getFirstVaultAccountId = async () => {
  return null;
};

export const createTransaction = async (txObject) => {
  return false;
};

export const estimateTransactionFee = async (txObject) => {
  return false;
};

export const getGasStationConfigs = async (assetId) => {
  return false;
};

export const setGasStationConfigs = async (
  assetId,
  gasThreshold,
  gasCap,
  maxGasPrice
) => {
  return false;
};

export const validateAddress = async (assetId, address) => {
  // Paper trading: no on-chain validation
  return false;
};

export const getGasStation = async () => {
  return false;
};

export const getInternalWallets = async () => {
  // Callers call find on the result — return an empty list
  return [];
};

export const getInternalWalletAssets = async () => {
  return false;
};

export const fireblocksAuthMiddleware = async (req, res, next) => {
  return res
    .status(400)
    .json({ success: false, message: "Disabled in paper trading mode" });
};

export const fireblocksPOST = async (req, res) => {
  return res
    .status(200)
    .json({ success: true, message: "Paper trading mode - webhook disabled" });
};

export const confirmTransactions2 = async (body, res) => {
  return res
    .status(200)
    .json({ success: true, message: "Paper trading mode - deposits disabled" });
};

export const adminMoveStatusFireBase = async (body, res) => {
  return res
    .status(200)
    .json({ success: true, message: "Paper trading mode" });
};

export const depositMoveToAdminFireBase = async () => {
  // Paper trading: sweep disabled
  return true;
};
