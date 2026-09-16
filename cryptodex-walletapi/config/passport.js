//import npm package
import { Strategy as JwtStrategy, ExtractJwt } from "passport-jwt";
//import function
import config from "./index.js";

var opts = {};
opts.jwtFromRequest = ExtractJwt.fromAuthHeaderAsBearerToken();
opts.secretOrKey = config.secretOrKey;
// SECURITY: never log secretOrKey, not even a prefix. A prefix of an HMAC
// signing key is still key material and it lands in wallet-api.log / stdout.

//import model

// import lib
import isEmpty from "../lib/isEmpty.js";

// import grpc

import { hget } from "../controllers/redis.controller.js";

export const usersAuth = (passport) => {
  passport.use(
    "usersAuth",
    new JwtStrategy(opts, async function (payload, done) {
      try {
        // SECURITY: this callback runs on EVERY authenticated request. The
        // Redis "userToken" record it reads carries the user's email and the
        // session tokenId, so it must never be printed. It used to carry
        // `secret2FA` (the TOTP seed) as well - dumping it put a working second
        // factor into wallet-api.log on every request. 2FA has since been
        // removed from this venue and userapi no longer writes that field at
        // all, so the seed is gone from the record rather than merely unlogged;
        // the no-logging rule stays because the rest is still session material.
        // Same reason payload/tokenId are not echoed: the log
        // then doubles as a session-hijacking oracle.
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
            firstName: "",
          };
          return done(null, data);
        }
        return done(null, false);
      } catch (error) {
        // Message only - the error object can carry the token/payload.
        console.log("usersAuth strategy error:", error?.message || error);
        return done(error);
      }
    })
  );
};

// `adminAuth` was removed with the admin route file. It was the only consumer
// of the `fetchAdmin` gRPC call from this service, and nothing here
// authenticates as an admin any more: the admin panel is gone and every
// surviving walletapi route is a user route. A registered strategy that dials
// another service and that nothing can ever invoke is exactly the residue this
// reduction is meant to remove.

// `TRXserviceJWT`, `BNBserviceJWT` and `ETHserviceJWT` were removed here.
//
// They were RS256 middlewares that authenticated the TRX / BNB / ETH chain
// gateway calling INTO this service, verifying the caller's JWT against
// config/{trx,bnb,eth}_public_key.pem and comparing its `id` against
// SERVICE_WALLET_*_ID. No route in this service ever mounted them - the chain
// gateways they guarded are gone with the custody surface, and this is a paper
// venue with no on-chain callers at all.
//
// They mattered beyond being dead: BNBserviceJWT and ETHserviceJWT each did
// `console.log("TOKEN", token)` on the raw Authorization header and
// `console.log("DECODED", decoded, ...)` on the verified claims, which is the
// exact shape 365d083 ("stop writing live session JWTs to log files") set out
// to remove. It survived that sweep only because the functions were
// unreachable and so never showed up in a log to be noticed.
//
// The three `*_public_key.pem` files in this directory were read ONLY by these
// functions. The three `*_private_key.pem` files were read only by
// config/jwt.js, whose signers (walletServSign / bnbServSign / ethServSign /
// trxServSign) were reachable from nothing but one dead import in
// currency.controller.js. That module and all six .pem files are deleted: they
// were live RSA key material committed to the repository.
