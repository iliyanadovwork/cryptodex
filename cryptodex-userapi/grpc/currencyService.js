// import package

import grpc from '@grpc/grpc-js'
import protoLoader from '@grpc/proto-loader'
import { fileURLToPath } from 'url';
import { dirname } from 'path';


// import config
import config from '../config/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = __dirname + "/currency.proto";

const options = {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
};

const pkgDef = protoLoader.loadSync(PROTO_PATH, options);
const Client = grpc.loadPackageDefinition(pkgDef).Req;


// This module used to open with three fs.readFileSync calls against a
// ./private/walletapi.<hostname>.{ca,key,crt} triplet - executed on every
// boot, because this file is on userapi's import chain - and hand the result
// to a grpc.credentials.createSsl() that the line below then ignored. The
// channel has always been insecure. The files were live TLS key material
// committed to the repository under a deployment hostname; they are gone.
const client = new Client(config.GRPC.WALLET_URL, grpc.credentials.createInsecure());

export const currencyId = async (reqBody) => {
    return new Promise((resolve, reject) => {
        client.currencyId({
            id: reqBody.id,
        }, (err, resp) => {
            console.log("--currencyId----resp", resp)
            if (err) {
                console.log(err, 'err')
                reject(err);
            }
            else (resolve(resp));
        });
    }).catch((err) => {
        console.log("---currencyId----err", err)
        return { 'status': false, 'error': 'Error on Connection' }
    });
}
export const priceConversionGrpc = async (reqBody) => {
    return new Promise((resolve, reject) => {
        client.priceConversionGrpc({
            baseSymbol: reqBody.baseSymbol,
            convertSymbol: reqBody.convertSymbol
        }, (err, resp) => {
            if (err) reject(err);
            else (resolve(resp));
        });
    }).catch((err) => {
        return { 'status': false, 'error': 'Error on Connection' }
    });
}