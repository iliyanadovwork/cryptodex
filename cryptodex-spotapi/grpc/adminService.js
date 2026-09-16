import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// import config
import config from '../config/index.js';

// (No mTLS credential import. Every channel in this service is
// grpc.credentials.createInsecure() - see the note in server.js.)

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const options = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};

// adminservice
const ADMIN_PROTO_PATH = __dirname + "/admin.proto";
const adminPkgDef = protoLoader.loadSync(ADMIN_PROTO_PATH, options);
const Admin = grpc.loadPackageDefinition(adminPkgDef).Req;

// const AdminService = new Admin(config.GRPC.USER_URL, credentials);
const AdminService = new Admin(config.GRPC.USER_URL, grpc.credentials.createInsecure());

// `fetchAdmin` was here. It asked userapi "is this JWT a live admin", and its
// only caller was the `adminAuth` passport strategy guarding `/api/admin` -
// both of which are gone. See config/passport.js.
//
// `saveAdminprofit` STAYS, and nothing about it changes. It is named for the
// reporting screen that used to READ the profit rows, but it is written on the
// ordinary trading path: every maker and taker fee the matcher charges is
// booked through here. Trading fees are not being removed.
export const saveAdminprofit = async (reqBody) => {
  return new Promise((resolve, reject) => {
    AdminService.saveAdminprofit({
      userId: reqBody.userId.toString(),
      ordertype: reqBody.ordertype,
      pair: reqBody.pair,
      fee: reqBody.fee,
      coin: reqBody.coin,
    }, (err, resp) => {
      if (err) {
        console.log(err, 'eeeeeee');
        reject(err);
      } else (resolve(resp));
    });
  }).catch((err) => {
    return { 'status': false, 'error': 'Error on Connection' }
  });
};
