//import npm package
import { Strategy as JwtStrategy, ExtractJwt } from "passport-jwt";
//import function
import config from "./index.js";

var opts = {};
opts.jwtFromRequest = ExtractJwt.fromAuthHeaderAsBearerToken();
opts.secretOrKey = config.secretOrKey;

//import model
import { User } from "../models/index.js";

// import controllers
import { hget } from "../controllers/redis.controller.js";

// import lib
import isEmpty from "../lib/isEmpty.js";

// export const usersAuth = (passport) => {
//     passport.use("usersAuth",
//         new JwtStrategy(opts, async function (jwt_payload, done) {
//             User.findById(jwt_payload._id, function (err, user) {
//                 if (err) { return done(err, false) }
//                 else if (user) {
//                     let data = {
//                         id: user._id,
//                         userId: user.userId,
//                         binSubAcctEmail: user.binSubAcctEmail
//                     }
//                     return done(null, data);
//                 }
//                 return done(null, false)
//             })
//         })
//     )
// }
export const usersAuth = (passport) => {
  passport.use(
    "usersAuth",
    new JwtStrategy(opts, async function (payload, done) {
      if (payload.role == "user") {
        let userDoc = await hget("userToken", payload._id);
        userDoc = JSON.parse(userDoc);
        if (isEmpty(userDoc) || userDoc.userLocked != "false") {
          return done(null, false);
        } else if (userDoc.tokenId != payload.tokenId) {
          return done(null, false);
        }
        let data = {
          id: payload._id,
          userCode: userDoc.userCode,
          type: userDoc.type,
          email: userDoc.email,
          walletaddress: userDoc.walletaddress,
        };
        return done(null, data);
      }
      return done(null, false);
    })
  );
};

// `adminAuth` USED TO LIVE HERE.
//
// It was the JWT strategy in front of routes/admin.route.js, and it resolved a
// token straight out of the `admin` collection. routes/admin.route.js and every
// one of its 63 endpoints are gone, so the strategy guarded nothing and only
// server.js still called it. The `admin` collection and models/admin.js STAY:
// spotapi and walletapi still ask this service for an operator record over
// gRPC (grpc/server.js -> auth.controller.fetchAdmin), and that is a
// service-to-service read, not an HTTP surface.
