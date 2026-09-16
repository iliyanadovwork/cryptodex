import grpc from '@grpc/grpc-js'
import protoLoader from '@grpc/proto-loader'
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROTO_PATH = __dirname + "/news.proto";
const WALLET_PROTO_PATH = __dirname + "/wallet.proto.js";

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

const walletPkgDef = protoLoader.loadSync(WALLET_PROTO_PATH, options);
const Wallet = grpc.loadPackageDefinition(walletPkgDef).Req;
const walletService = new Wallet(
    "localhost:50051",
    grpc.credentials.createInsecure()
);

// var packageDefinition = protoLoader.loadSync(PROTO_PATH, options);
// const NewsService = grpc.loadPackageDefinition(packageDefinition).NewsService;
// const walletClient1 = new NewsService(
//     "localhost:50051",
//     grpc.credentials.createInsecure()
// );

// module.exports = walletClient;

export { walletService }