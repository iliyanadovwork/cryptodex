import grpc from '@grpc/grpc-js'
import protoLoader from '@grpc/proto-loader'
import { fileURLToPath } from 'url';
import { dirname } from 'path';
// import config
import config from '../config/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROTO_PATH = __dirname + "/news.proto";
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
// const client = new Wallet(config.GRPC.WALLET_URL, credentials);
const client = new Wallet(config.GRPC.WALLET_URL, grpc.credentials.createInsecure());

export const newAsset = async (reqBody) => {
    return new Promise((resolve, reject) => {
        client.newAsset({
            userId: reqBody.userId,
            userCode: reqBody.userCode,
        }, (err, resp) => {
            if (err) reject(err);
            else (resolve(resp));
        });
    }).catch((err) => {
        console.log(err, "errerrerr")
        return { 'status': false, 'error': 'Error on Connection' }
    });
}

export const getAdminDashboard = async () => {
    return new Promise((resolve, reject) => {
        client.getAdminDashboard({}, (err, resp) => {
            if (err) reject(err);
            else (resolve(resp));
        });
    }).catch((err) => {
        console.log(err)
        return { 'status': false, 'error': 'Error on Connection' }
    });
}

// This was the only client in this file without a .catch(), so a gRPC failure
// escaped as a rejected promise into whatever awaited it. Its one caller,
// confirmDeActive, awaited it AFTER it had already committed a destructive
// write, so the rejection turned a half-finished teardown into a 500 and left
// the account shredded with its orders resting and its session alive. It now
// reports failure the same way its siblings do - a { status: false } the
// caller has to look at - and callers MUST check it: `status: false` means the
// wallet was NOT stood down.
//
// walletapi NOW IMPLEMENTS THIS. It did not, for the whole life of the feature:
// the method was declared here and nowhere else, so it answered
// `12 UNIMPLEMENTED` on every call and the mandatory wallet gate in
// confirmDeActive turned every deactivation attempt into a 503. The server side
// is walletapi/lib/walletStandDown.js + controllers/wallet.js#deactivateWallet.
//
// `mode` selects what to do, and is optional so nothing that predates it
// changes behaviour:
//   ""/"freeze"  stand the wallet down (default)
//   "unfreeze"   bring it back - the operator restore, and the compensating
//                action confirmDeActive runs if a LATER step fails
//   "check"      read-only preflight: can this wallet be stood down?
export const deactivateWallet = async (reqBody) => {
    return new Promise((resolve, reject) => {
        client.deactivateWallet(
            {
                userId: reqBody.userId,
                mode: reqBody.mode || "",
            },
            (err, resp) => {
                if (err) reject(err);
                else resolve(resp);
            }
        );
    }).catch((err) => {
        console.log("---deactivateWallet----err", err);
        return { status: false, error: "Error on Connection" };
    });
};