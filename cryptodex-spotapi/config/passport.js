//import npm package
import { Strategy as JwtStrategy, ExtractJwt } from "passport-jwt";

//import function
import config from "./index.js";

var opts = {};
opts.jwtFromRequest = ExtractJwt.fromAuthHeaderAsBearerToken();
opts.secretOrKey = config.secretOrKey;

// import lib
import isEmpty from "../lib/isEmpty.js";

// import controller
import { hget } from "../controllers/redis.controller.js";

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
        };
        return done(null, data);
      }
      return done(null, false);
    })
  );
};

// THE `adminAuth` STRATEGY IS GONE.
//
// It authenticated the 14 `/api/admin` endpoints by asking userapi over gRPC
// whether a JWT belonged to a live admin. Those endpoints have been removed
// (see server.js), so the strategy guarded nothing - and it was the only caller
// of `fetchAdmin`, which is why that gRPC client went with it.
//
// `saveAdminprofit` in grpc/adminService.js is DELIBERATELY UNTOUCHED. Despite
// the shared "admin" name it is not part of the admin surface: it is how the
// matcher books every maker and taker fee it charges, on the ordinary trading
// path, and trading fees are staying exactly as they are.
