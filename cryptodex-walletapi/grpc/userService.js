import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// import config
import config from '../config/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url));
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

export const bankDetail = async (reqBody) => {
    return new Promise((resolve, reject) => {
        console.log(reqBody, 'bankdetail reqBody')
        UserService.bankDetail({
            id: reqBody.id
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

export const sendMail = async (reqBody) => {
    return new Promise((resolve, reject) => {
        console.log(reqBody, 'bankdetail reqBody')
        UserService.sendMail({
            id: reqBody.userId,
            identifier: reqBody.identifier,
            toEmail: reqBody.toEmail,
            content: JSON.stringify(reqBody.content),
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


// Calls userapi's `notification` RPC (userapi/grpc/server.js), which hands the
// decoded message straight to `new Notification(doc)`. Only the three fields in
// notificationReq exist on the wire: userId, title, description. The previous
// implementation called `newNotification` - a method userapi does not serve - and
// passed `viewType` and `type`, neither of which is a field of the server's
// message; both were dropped by the encoder before the call even left.
export const notification = async (reqBody) => {
    return new Promise((resolve, reject) => {
        UserService.notification({
            userId: reqBody.userId,
            title: reqBody.title,
            description: reqBody.description
        }, (err, resp) => {
            if (err) {
                console.log(err)
                reject(err);
            }
            else (resolve(resp));
        });
    }).catch((err) => {
        console.log(err)
        return { 'status': false, 'error': 'Error on Connection' }
    });
}