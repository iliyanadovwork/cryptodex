// import package
import grpc from '@grpc/grpc-js'
import protoLoader from '@grpc/proto-loader'
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// import config
import config from "../config/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROTO_PATH = __dirname + "/spot.proto";

const options = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};

const pkgDef = protoLoader.loadSync(PROTO_PATH, options);
const Client = grpc.loadPackageDefinition(pkgDef).Req;

const client = new Client(
  config.GRPC.SPOT_URL,
  grpc.credentials.createInsecure()
);

export const cancelOrderForDeactiveAcc = async (reqBody) => {
  return new Promise((resolve, reject) => {
    client.cancelOrderForDeactiveAcc(
      {
        userId: reqBody.userId,
      },
      (err, resp) => {
        console.log("--cancelOrderForDeactiveAcc----resp", resp);
        if (err) {
          console.log(err, "err");
          reject(err);
        } else resolve(resp);
      }
    );
  }).catch((err) => {
    console.log("---cancelOrderForDeactiveAcc----err", err);
    return { status: false, error: "Error on Connection" };
  });
};
