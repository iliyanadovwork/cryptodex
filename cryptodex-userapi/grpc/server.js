import { fileURLToPath } from "url";
import { dirname } from "path";
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";

// import controller
import { getSiteSet } from "../controllers/siteSetting.controller.js";
import {
  fetchUser,
  fetchAdmin,
  getBankDetails,
  fetchBotUser,
} from "../controllers/auth.controller.js";
import { sendMail } from "../controllers/mail.js";
import { saveAdminprofit } from "../controllers/adminProfit.controller.js";
import { botUser } from "../controllers/auth.controller.js";
import { newNotification } from "../controllers/notification.controller.js";

// import config
import config from "../config/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const server = new grpc.Server();
const options = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};

// Enable gRPC server logging
grpc.setLogger(console);
grpc.setLogVerbosity(grpc.logVerbosity.INFO); // Set log level

//Site setting
const SITE_SET_PROTO_PATH = __dirname + "/siteSetting.proto";
const sitePkgDef = protoLoader.loadSync(SITE_SET_PROTO_PATH, options);
const siteProto = grpc.loadPackageDefinition(sitePkgDef);

//user
const USER_PROTO_PATH = __dirname + "/user.proto";
const userPkgDef = protoLoader.loadSync(USER_PROTO_PATH, options);
const userProto = grpc.loadPackageDefinition(userPkgDef);

//Admin
const ADMIN_PROTO_PATH = __dirname + "/admin.proto";
const adminPkgDef = protoLoader.loadSync(ADMIN_PROTO_PATH, options);
const adminProto = grpc.loadPackageDefinition(adminPkgDef);

server.addService(siteProto.Req.service, {
  siteSetting: async (_, callback) => {
    let data = await getSiteSet();
    callback(null, data);
  },
});

server.addService(userProto.Req.service, {
  fetchUser: async (_, callback) => {
    let data = await fetchUser(_.request);
    callback(null, data);
  },
  fetchBotUser: async (_, callback) => {
    let data = await fetchBotUser(_.request);
    callback(null, data);
  },
  notification: async (_, callback) => {
    let data = await newNotification(_.request);
    callback(null, data);
  },
  bankDetail: async (_, callback) => {
    let data = await getBankDetails(_.request);
    callback(null, data);
  },
  sendMail: async (_, callback) => {
    let data = await sendMail(_.request);
    callback(null, data);
  },
  botUser: async (_, callback) => {
    let data = await botUser(_.request);
    callback(null, data);
  },
  // THE LAST TWO P2P READS ARE GONE.
  //
  // `fetchUserPayment` (a user's bank / UPI / QR payment methods) and
  // `fetchP2BuyerSellerDetails` (the two counterparties on a p2p trade) were
  // the last two p2p reads in this service. There has been no p2p engine to
  // call them for some time - no service in this repo binds either method - and
  // fetchUserPayment served the bank/UPI/QR collections whose HTTP routes were
  // already removed. Both are gone from here, from user.proto and from
  // user.controller.js.
  //
  // `changeLeverage` is gone the same way and for the same reason: no service
  // in this repo bound it, and it wrote a `leverage` preference that
  // models/userSetting.js no longer declares.
});

server.addService(adminProto.Req.service, {
  fetchAdmin: async (_, callback) => {
    let data = await fetchAdmin(_.request);
    callback(null, data);
  },
  saveAdminprofit: async (_, callback) => {
    let data = await saveAdminprofit(_.request);
    callback(null, data);
  },
});

// Plaintext gRPC on loopback, deliberately. A commented-out
// ServerCredentials.createSsl() reading ./private/server-certs/* stood here;
// the cert surface it named has been deleted (it was live key material,
// committed to the repository). See spotapi/grpc/server.js for the full note.
server.bindAsync(
  config.GRPC.URL,
  grpc.ServerCredentials.createInsecure(),
  (error, port) => {
    if (error) {
      console.log(error, "SERVER-Error");
    }
    console.log("Server at port:", port);
    server.start();
  }
);
