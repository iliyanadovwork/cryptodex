/**
 * SESSION TOKENS - AGAINST THE SHIPPED SIGNER AND THE SHIPPED STRATEGY
 * ====================================================================
 *
 * WHAT THIS FILE USED TO BE
 * -------------------------
 * It imported `jsonwebtoken` and nothing else, then signed and verified tokens
 * with a locally declared `const TEST_SECRET = 'test-secret-key'`. It asserted
 * that jsonwebtoken round-trips a payload, that a wrong secret throws, and that
 * an expired token throws - all true of the LIBRARY, none of them true or false
 * of this service. config/passport.js and models/User.generateJWT were never
 * loaded.
 *
 * WHAT IT IS NOW
 * --------------
 * The real `User.generateJWT` (the only thing that mints a user session in this
 * service) and the real `usersAuth` passport strategy from config/passport.js,
 * driven directly with a stubbed redis so the verification logic is exercised
 * as a unit.
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

// The strategy's ONLY out-of-process dependency: the redis session hash.
// `mock`-prefixed so babel-plugin-jest-hoist permits the factory to close over
// it, and written as PLAIN functions rather than jest.fn()s because
// jest.config.js sets `resetMocks: true`, which would strip a jest.fn()'s
// implementation between tests and leave the strategy reading `undefined`.
const mockRedisRows = new Map();
jest.mock("../../controllers/redis.controller.js", () => ({
  __esModule: true,
  hget: async (key, id) => {
    const row = mockRedisRows.get(`${key}:${id}`);
    return row === undefined ? null : JSON.stringify(row);
  },
  hset: async () => {},
  hdel: async () => {},
  hgetall: async () => ({}),
  hmset: async () => true,
}));

const { User } = require("../../models/index.js");
const config = require("../../config/index.js").default;
const { usersAuth } = require("../../config/passport.js");

/** Register the real strategy against a passport double and hand back its verify fn. */
const realVerify = () => {
  let captured = null;
  usersAuth({ use: (_name, strategy) => (captured = strategy) });
  expect(captured).toBeTruthy();
  return (payload) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("strategy never called done()")),
        2000
      );
      try {
        captured._verify(payload, (err, user) => {
          clearTimeout(timer);
          resolve({ err, user });
        });
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
};

const seedSession = (userId, row) => mockRedisRows.set(`userToken:${userId}`, row);

beforeEach(() => mockRedisRows.clear());

describe("models/User.generateJWT", () => {
  test("mints a Bearer token the service's own secret verifies", () => {
    const id = new mongoose.Types.ObjectId();
    const raw = new User().generateJWT({ _id: id, role: "user", tokenId: "t1" });
    expect(raw).toMatch(/^Bearer eyJ/);
    const decoded = jwt.verify(raw.slice(7), config.secretOrKey);
    expect(decoded._id).toBe(id.toString());
  });

  test("uses HS256 and cannot be downgraded to alg:none", () => {
    const raw = new User().generateJWT({ _id: "x", role: "user" });
    const header = JSON.parse(
      Buffer.from(raw.slice(7).split(".")[0], "base64").toString("utf8")
    );
    expect(header.alg).toBe("HS256");

    // A forged unsigned token with the same body must not verify.
    const body = raw.slice(7).split(".")[1];
    const noneToken = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${body}.`;
    expect(() => jwt.verify(noneToken, config.secretOrKey)).toThrow();
  });

  /**
   * DEFECT, DOCUMENTED NOT FIXED - reported separately.
   *
   * models/User.js signs with `{ expiresIn: 1 * 1000 * 60 * 60 * 24 }`. A
   * NUMERIC `expiresIn` is interpreted by jsonwebtoken as SECONDS, so that
   * arithmetic - which is milliseconds-for-one-day - yields 86,400,000 seconds,
   * i.e. about 1000 days, not 24 hours. The intent is unambiguous from the
   * expression; the unit is wrong.
   *
   * The practical blast radius is bounded by the redis `userToken` row (the
   * strategy below refuses any token whose session row is gone or whose
   * tokenId has rotated), but a token that leaks while a session is live stays
   * cryptographically valid for ~2.7 years instead of one day.
   *
   * This test pins the CURRENT lifetime so the defect cannot be closed
   * silently: when it is fixed, this goes red and must be changed to 86400.
   */
  test("the signed lifetime is 24 hours (86,400 seconds), not ~1000 days", () => {
    // generateJWT now passes expiresIn: "24h". The old numeric
    // `1 * 1000 * 60 * 60 * 24` was read by jsonwebtoken as SECONDS (~1000 days);
    // this pins the fix so the ~2.7-year token cannot come back.
    const raw = new User().generateJWT({ _id: "x", role: "user" });
    const { iat, exp } = jwt.verify(raw.slice(7), config.secretOrKey);
    expect(exp - iat).toBe(24 * 60 * 60);
    expect(exp - iat).not.toBe(1 * 1000 * 60 * 60 * 24);
  });
});

describe("config/passport.js usersAuth - the real session resolution", () => {
  const payloadFor = (id, tokenId = "t1", role = "user") => ({
    _id: id.toString(),
    tokenId,
    role,
  });

  test("accepts a payload whose redis row matches, and projects only session fields", async () => {
    const verify = realVerify();
    const id = new mongoose.Types.ObjectId();
    seedSession(id, {
      userLocked: "false",
      tokenId: "t1",
      userCode: "UC1",
      type: "basic_verified",
      email: "u@example.com",
      walletaddress: "0xabc",
      // A stale session row written before 2FA was removed still carries this.
      // The projection must NOT pick it up: the strategy runs on every
      // authenticated request, so anything it copies ends up in `req.user` and
      // in anything that logs `req.user`.
      secret2FA: "S3CR3T",
      hash: "must-not-be-projected",
    });

    const { err, user } = await verify(payloadFor(id));
    expect(err).toBeNull();
    expect(user).toEqual({
      id: id.toString(),
      userCode: "UC1",
      type: "basic_verified",
      email: "u@example.com",
      walletaddress: "0xabc",
    });
    expect(user.hash).toBeUndefined();
    expect(user.secret2FA).toBeUndefined();
  });

  test("refuses a payload whose tokenId no longer matches the stored session", async () => {
    const verify = realVerify();
    const id = new mongoose.Types.ObjectId();
    seedSession(id, { userLocked: "false", tokenId: "current" });
    const { user } = await verify(payloadFor(id, "stale"));
    expect(user).toBe(false);
  });

  test("refuses when there is no session row at all", async () => {
    const verify = realVerify();
    const { user } = await verify(payloadFor(new mongoose.Types.ObjectId()));
    expect(user).toBe(false);
  });

  test("refuses a locked account", async () => {
    const verify = realVerify();
    const id = new mongoose.Types.ObjectId();
    seedSession(id, { userLocked: "true", tokenId: "t1" });
    expect((await verify(payloadFor(id))).user).toBe(false);
  });

  test("refuses any role other than user, without even reading redis", async () => {
    const verify = realVerify();
    const id = new mongoose.Types.ObjectId();
    seedSession(id, { userLocked: "false", tokenId: "t1", userCode: "UC1" });

    expect((await verify(payloadFor(id, "t1", "admin"))).user).toBe(false);
    // A payload with no `role` claim at all.
    expect(
      (await verify({ _id: id.toString(), tokenId: "t1" })).user
    ).toBe(false);
    // "app-user" was minted only by the unmounted mobile-app login controllers.
    // Those are gone, so the role is no longer issuable and is refused like any
    // other unrecognised one.
    expect((await verify(payloadFor(id, "t1", "app-user"))).user).toBe(false);
    // The one role a real session carries.
    expect((await verify(payloadFor(id, "t1", "user"))).user).toBeTruthy();
  });

  test("`userLocked` is compared as a string, so any non-'false' value locks", async () => {
    const verify = realVerify();
    const id = new mongoose.Types.ObjectId();
    for (const locked of [true, "TRUE", "", 0, "no"]) {
      mockRedisRows.clear();
      seedSession(id, { userLocked: locked, tokenId: "t1", userCode: "UC1" });
      expect((await verify(payloadFor(id))).user).toBe(false);
    }
  });

  test("the strategy is registered under the name the routers ask for", () => {
    let name = null;
    usersAuth({ use: (n) => (name = n) });
    expect(name).toBe("usersAuth");
  });
});
