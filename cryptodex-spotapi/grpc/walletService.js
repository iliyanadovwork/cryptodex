import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// import config
import config from "../config/index.js";

// (No mTLS credential import. Every channel in this service is
// grpc.credentials.createInsecure() - see the note in server.js.)

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// import proto
const WALLET_PROTO_PATH = __dirname + "/wallet.proto";

const options = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};

const walletPkgDef = protoLoader.loadSync(WALLET_PROTO_PATH, options);
const Wallet = grpc.loadPackageDefinition(walletPkgDef).Req;
const client = new Wallet(
  config.GRPC.WALLET_URL,
  grpc.credentials.createInsecure()
);

// Add deadline to all calls (5 second timeout)
const DEADLINE_MS = 5000;

export const getUserAsset = async (reqBody) => {
  return new Promise((resolve, reject) => {
    const deadline = new Date();
    deadline.setMilliseconds(deadline.getMilliseconds() + DEADLINE_MS);

    client.getUserAsset(
      {
        id: reqBody.id,
        currencyId: reqBody.currencyId,
      },
      { deadline },
      (err, resp) => {
        if (err) reject(err);
        else resolve(resp);
      }
    );
  }).catch((err) => {
    console.error('[gRPC] getUserAsset error:', err.message);
    return { status: false, error: err.message };
  });
};

export const updateUserAsset = async (reqBody) => {
  return new Promise((resolve, reject) => {
    const deadline = new Date();
    deadline.setMilliseconds(deadline.getMilliseconds() + DEADLINE_MS);

    client.updateUserAsset(
      {
        id: reqBody.id,
        currencyId: reqBody.currencyId,
        spotBal: reqBody.spotBal,
      },
      { deadline },
      (err, resp) => {
        if (err) reject(err);
        else resolve(resp);
      }
    );
  }).catch((err) => {
    console.error('[gRPC] updateUserAsset error:', err.message);
    return { status: false, error: err.message };
  });
};

export const updateUserWallet = async (id) => {
  return new Promise((resolve, reject) => {
    const deadline = new Date();
    deadline.setMilliseconds(deadline.getMilliseconds() + DEADLINE_MS);

    client.updateUserWallet(
      {
        id: id,
      },
      { deadline },
      (err, resp) => {
        if (err) reject(err);
        else resolve(resp);
      }
    );
  }).catch((err) => {
    return { status: false, error: "Error on Connection" };
  });
};

/**
 * Every passbook row is an audit record of money that has ALREADY moved, so a
 * row that cannot be written must be shouted about here rather than dropped:
 * walletapi rejects non-numeric balances (it will not store NaN), and the only
 * place that knows which ledger read produced the bad number is this side.
 */
const NUMERIC_PASSBOOK_FIELDS = ["beforeBalance", "afterBalance", "amount"];

export const passbook = async (reqBody) => {
  const nonNumeric = NUMERIC_PASSBOOK_FIELDS.filter(
    (field) => !Number.isFinite(parseFloat(reqBody?.[field]))
  );
  if (nonNumeric.length > 0) {
    console.error(
      '[gRPC] passbook NOT SENT - non-numeric',
      nonNumeric.join(', '),
      'the audit row for this movement will be missing:',
      JSON.stringify({
        userId: reqBody?.userId,
        coin: reqBody?.coin,
        type: reqBody?.type,
        tableId: reqBody?.tableId,
        beforeBalance: reqBody?.beforeBalance,
        afterBalance: reqBody?.afterBalance,
        amount: reqBody?.amount,
      })
    );
    return { status: false, error: `non-numeric ${nonNumeric.join(', ')}` };
  }

  return new Promise((resolve, reject) => {
    const deadline = new Date();
    deadline.setMilliseconds(deadline.getMilliseconds() + DEADLINE_MS);

    client.passbook(
      {
        userId: reqBody.userId,
        coin: reqBody.coin,
        currencyId: reqBody.currencyId,
        tableId: reqBody.tableId,
        beforeBalance: reqBody.beforeBalance.toString(),
        afterBalance: reqBody.afterBalance.toString(),
        amount: reqBody.amount.toString(),
        type: reqBody.type,
        category: reqBody.category,
      },
      { deadline },
      (err, resp) => {
        if (err) reject(err);
        else resolve(resp);
      }
    );
  })
    .then((resp) => {
      if (resp && resp.status === false) {
        console.error(
          '[gRPC] passbook row REJECTED by walletapi:',
          JSON.stringify({
            userId: reqBody?.userId,
            coin: reqBody?.coin,
            type: reqBody?.type,
            tableId: reqBody?.tableId,
          })
        );
      }
      return resp;
    })
    .catch((err) => {
      console.error('[gRPC] passbook error:', err.message);
      return { status: false, error: err.message };
    });
};
