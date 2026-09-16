import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "url";
import { dirname } from "path";

// import config
import config from "../config/index.js";

// import lib
import { recordGrpcBind } from "../lib/grpcHealth.js";

// import controller
import { emptyAsset } from "../controllers/createAsset.js";
import {
  getCurrencyId,
  getCurrencySymbol,
} from "../controllers/currency.controller.js";
// `getAdminDashboard` was removed with the admin panel. It answered the
// operator dashboard's deposit/withdraw tiles for today; there is no operator
// UI to render them and no caller left.
import { priceConversionGrpc } from "../controllers/priceCNV.controller.js";

// import grpc
import {
  getUserAsset,
  updateUserAsset,
  updateUserWallet,
  passbook,
  getUserAllAsset,
  getCnvPrice,
  deactivateWallet,
} from "../controllers/wallet.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROTO_PATH = __dirname + "/news.proto";
const WALLET_PROTO_PATH = __dirname + "/wallet.proto";

// Enable gRPC server logging
grpc.setLogger(console);
grpc.setLogVerbosity(grpc.logVerbosity.INFO); // Set log level

const server = new grpc.Server();
const options = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};
var packageDefinition = protoLoader.loadSync(PROTO_PATH, options);
const newsProto = grpc.loadPackageDefinition(packageDefinition);

// Wallet Service
const walletPkgDef = protoLoader.loadSync(WALLET_PROTO_PATH, options);
const walletProto = grpc.loadPackageDefinition(walletPkgDef);

server.addService(walletProto.Req.service, {
  newAsset: (_, callback) => {
    emptyAsset(_.request);
    callback(null, { status: true });
  },
  getUserAsset: async (_, callback) => {
    let data = await getUserAsset(_.request);
    callback(null, data);
  },
  updateUserAsset: async (_, callback) => {
    let data = await updateUserAsset(_.request);
    callback(null, data);
  },
  updateUserWallet: async (_, callback) => {
    let data = await updateUserWallet(_.request);
    callback(null, data);
  },
  passbook: async (_, callback) => {
    let data = await passbook(_.request);
    callback(null, data);
  },
  getUserAllAsset: async (_, callback) => {
    let data = await getUserAllAsset(_.request);
    callback(null, data);
  },
  getCnvPrice: async (_, callback) => {
    let data = await getCnvPrice(_.request);
    callback(null, data);
  },
  // The method userapi's account deactivation has always called and this
  // service never implemented, which made deactivation impossible (12
  // UNIMPLEMENTED -> the mandatory wallet gate in /deactive-confirm failed on
  // every attempt). It never rejects: the caller decides what to do with
  // status:false, and a gRPC-level error would look identical to the outage
  // this used to be.
  deactivateWallet: async (_, callback) => {
    let data = await deactivateWallet(_.request);
    callback(null, data);
  },
});

// Currency Service
const CURRENCY_PROTO_PATH = __dirname + "/currency.proto";
const curPkgDef = protoLoader.loadSync(CURRENCY_PROTO_PATH, options);
const curProto = grpc.loadPackageDefinition(curPkgDef);
server.addService(curProto.Req.service, {
  currencyId: async (_, callback) => {
    let data = await getCurrencyId(_.request);
    callback(null, data);
  },
  currencySymbol: async (_, callback) => {
    let data = await getCurrencySymbol(_.request);
    callback(null, data);
  },
  priceConversionGrpc: async (_, callback) => {
    let data = await priceConversionGrpc(_.request);
    callback(null, data);
  },
  // `getFromPriceCnvP2P` was registered here. It served the p2p wallet's
  // price conversions; the p2p product is gone and no service in this stack
  // has ever held a client for it, so it was an unreachable handler over a
  // controller nothing else called.
});

const news = [
  { id: "1", title: "Note 1", body: "Content 1", postImage: "Post image 1" },
  { id: "2", title: "Note 2", body: "Content 2", postImage: "Post image 2" },
];

server.addService(newsProto.NewsService.service, {
  getAllNews: (_, callback) => {
    console.log("-----news", news);
    callback(null, { news });
  },
  getNews: (_, callback) => {
    const newsId = _.request.id;
    const newsItem = news.find(({ id }) => newsId == id);
    callback(null, newsItem);
  },
  deleteNews: (_, callback) => {
    const newsId = _.request.id;
    news = news.filter(({ id }) => id !== newsId);
    callback(null, {});
  },
  editNews: (_, callback) => {
    const newsId = _.request.id;
    const newsItem = news.find(({ id }) => newsId == id);
    newsItem.body = _.request.body;
    newsItem.postImage = _.request.postImage;
    newsItem.title = _.request.title;
    callback(null, newsItem);
  },
  addNews: (call, callback) => {
    let _news = { id: Date.now(), ...call.request };
    news.push(_news);
    callback(null, _news);
  },
});


// Plaintext gRPC on loopback, deliberately. A commented-out
// ServerCredentials.createSsl() stood here, naming a CA, cert and private key
// filed under an unrelated external hostname. That key material has been
// deleted from the repository. See spotapi/grpc/server.js for the full note on
// why the mechanism went with it.
server.bindAsync(
  config.GRPC.WALLET_URL,
  grpc.ServerCredentials.createInsecure(),
  (error, port) => {
    if (error) console.log("error on GRPC server:", error);
    console.log("GRPC Wallet Server at port:", port);
    // RECORD THE BIND, so GET /api/health can report it.
    //
    // This is the socket every other service on the venue uses to read and move
    // a balance; express binding 3002 says nothing about it, and until now a
    // bind failure here printed one line and was invisible to any checker. A
    // bind that fails - or that has simply not happened yet, because express is
    // already listening by the time this module is imported - is a service that
    // is NOT READY, and health answers 503 for it. See lib/grpcHealth.js.
    recordGrpcBind({ address: config.GRPC.WALLET_URL, port, error });
    if (!error) server.start();
  }
);
