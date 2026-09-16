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

// userservice
const USER_PATH = __dirname + "/user.proto";
const userPkgDef = protoLoader.loadSync(USER_PATH, options);
const User = grpc.loadPackageDefinition(userPkgDef).Req;

const UserService = new User(config.GRPC.USER_URL, grpc.credentials.createInsecure());

export const fetchUser = async (reqBody) => {
    return new Promise((resolve, reject) => {
        UserService.fetchUser({
            id: reqBody.id
        }, (err, resp) => {
            if (err) {
                console.log(err, 'err')
                reject(err);
            }
            else (resolve(resp));
        });
    }).catch((err) => {
        return { 'status': false, 'error': 'Error on Connection' }
    });
}
export const fetchBotUser = async (reqBody) => {
    return new Promise((resolve, reject) => {
        UserService.fetchBotUser({
            id: reqBody.id
        }, (err, resp) => {
            if (err) {
                console.log(err, 'err')
                reject(err);
            }
            else (resolve(resp));
        });
    }).catch((err) => {
        return { 'status': false, 'error': 'Error on Connection' }
    });
}

export const botUser = async (reqBody) => {

    return new Promise((resolve, reject) => {

        UserService.botUser({
            firstName: reqBody.firstName,
            lastName: reqBody.lastName,
            email: reqBody.email,
            type: reqBody.type,
        }, (err, resp) => {
            if (err) {
                console.log(err, 'err')
                reject(err);
            }
            else (resolve(resp));
        });
    }).catch((err) => {
        console.log(err)
        return { 'status': false, 'error': 'Error on Connection' }
    });
}
