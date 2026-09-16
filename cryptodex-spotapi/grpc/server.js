import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// import config
import config from '../config/index.js'

// import controller
// import { getCurrencyId } from '../controllers/currency.controller.js'
import { cancelOrderForDeactiveAcc } from "../controllers/spot.controller.js";
// const PROTO_PATH = __dirname + "/news.proto";
const SPOT_PROTO_PATH = __dirname + "/spot.proto";

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


const spotPkgRef = protoLoader.loadSync(SPOT_PROTO_PATH, options);
const spotProto = grpc.loadPackageDefinition(spotPkgRef);

server.addService(spotProto.Req.service, {
    cancelOrderForDeactiveAcc: async (_, callback) => {
        let data = await cancelOrderForDeactiveAcc(_.request);
        callback(null, { status: true });
    },
});

// var packageDefinition = protoLoader.loadSync(PROTO_PATH, options);
// const newsProto = grpc.loadPackageDefinition(packageDefinition);

// THE p2p.proto SERVICE IS GONE, with the rest of the p2p remnants.
//
// It published one RPC, `fetchSpotPrice` -> pairManage.getAllMarkPrice, so that
// the p2p product could price an advert against the spot mark. That product has
// been removed and no service in this stack holds a client for it - the RPC had
// no possible caller, and `getAllMarkPrice` had no other one, so
// controllers/pairManage.controller.js went with it.
//
// Spot's own gRPC surface (spot.proto -> cancelOrderForDeactiveAcc, used by
// userapi on account deactivation) is registered above and is untouched.

// Currency Service
// const CURRENCY_PROTO_PATH = __dirname + "/currency.proto";
// const curPkgDef = protoLoader.loadSync(CURRENCY_PROTO_PATH, options);
// const curProto = grpc.loadPackageDefinition(curPkgDef);
// server.addService(curProto.Req.service, {
//     currencyId: async (_, callback) => {
//         let data = await getCurrencyId(_.request)
//         callback(null, data);
//     },
// })

// const news = [
//     { id: "1", title: "Note 1", body: "Content 1", postImage: "Post image 1" },
//     { id: "2", title: "Note 2", body: "Content 2", postImage: "Post image 2" },
// ];


// server.addService(newsProto.NewsService.service, {
//     getAllNews: (_, callback) => {
//         console.log("-----news", news)
//         callback(null, { news });
//     },
//     getNews: (_, callback) => {
//         const newsId = _.request.id;
//         const newsItem = news.find(({ id }) => newsId == id);
//         callback(null, newsItem);
//     },
//     deleteNews: (_, callback) => {
//         const newsId = _.request.id;
//         news = news.filter(({ id }) => id !== newsId);
//         callback(null, {});
//     },
//     editNews: (_, callback) => {
//         const newsId = _.request.id;
//         const newsItem = news.find(({ id }) => newsId == id);
//         newsItem.body = _.request.body;
//         newsItem.postImage = _.request.postImage;
//         newsItem.title = _.request.title;
//         callback(null, newsItem);
//     },
//     addNews: (call, callback) => {
//         let _news = { id: Date.now(), ...call.request };
//         news.push(_news);
//         callback(null, _news);
//     },
// });


// THIS VENUE'S gRPC IS PLAINTEXT ON LOOPBACK, AND SAYS SO.
//
// A `grpc.ServerCredentials.createSsl(...)` stood here, reading a CA, a cert
// and a private key out of `./private/server-certs/`. It was never passed to
// bindAsync - the bind below has always been createInsecure() - so the three
// files were read on every boot and the result thrown away. The same was true
// of the client side: `grpc/client-cred.js` built an mTLS credential that every
// live channel in this service ignored in favour of createInsecure().
//
// So mTLS was not switched on and turning it on was not a one-line change: the
// PEERS bind insecure too (userapi/grpc/server.js, walletapi/grpc/server.js).
// What the files did do was put 21 private keys into the repository under two
// unrelated deployment hostnames. They are gone, and with them the pretence.
//
// The four services run as one venue on one host and talk over 127.0.0.1. If
// this is ever split across machines, the channel needs real credentials AND
// the peers need to stop binding insecure - both ends, deliberately, with key
// material that is generated at deploy time and never committed.
server.bindAsync(config.GRPC.URL,
    grpc.ServerCredentials.createInsecure(),
    (error, port) => {
        if (error) {
            console.error("Failed to bind gRPC server:", error);
            return;
        }
        console.log("gRPC Server at port:", port);
        // Don't call start() - it's deprecated and no longer necessary
    }
);
