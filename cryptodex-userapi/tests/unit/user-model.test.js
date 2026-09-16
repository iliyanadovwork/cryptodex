/**
 * THE USER SCHEMA - AGAINST THE SHIPPED MODEL
 * ===========================================
 *
 * WHAT THIS FILE USED TO BE
 * -------------------------
 * It imported nothing but `crypto`. It re-declared makeSalt/encryptPassword in
 * the test file (a duplicate of password-hashing.test.js's duplicate), and then
 * described the schema in prose:
 *
 *     const validTypes = ['not_activate','basic_pending',...];
 *     expect(validTypes).toContain('basic_verified');
 *
 * i.e. it asserted that an array literal declared two lines above contained one
 * of its own elements. models/User.js was never loaded.
 *
 * WHAT IT IS NOW
 * --------------
 * Every assertion below reads the REAL `User.schema` or drives a REAL document.
 * No connection is needed: mongoose builds the schema, applies defaults and
 * runs validators entirely in-process, so this stays a unit test.
 */

import { describe, test, expect } from "@jest/globals";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";

import { User } from "../../models/index.js";
import config from "../../config/index.js";

describe("collection wiring", () => {
  test("the model is bound to the `user` collection", () => {
    expect(User.modelName).toBe("user");
    expect(User.collection.collectionName).toBe("user");
  });
});

describe("defaults a new account starts with", () => {
  const fresh = () => new User({ userId: "1", email: "a@b.co" });

  test("an account starts unverified, unlocked and unblocked", () => {
    const u = fresh();
    expect(u.status).toBe("unverified");
    expect(u.emailStatus).toBe("unverified");
    expect(u.phoneStatus).toBe("unverified");
    // userLocked is a STRING, and config/passport.js compares it with
    // `userDoc.userLocked != "false"`. A boolean here would lock everyone out.
    expect(u.userLocked).toBe("false");
    expect(typeof u.userLocked).toBe("string");
    expect(u.isBlock).toBe(false);
    expect(u.login_attempt).toBe(0);
    expect(u.role).toBe("user");
    expect(u.type).toBe("basic_pending");
    expect(u.percentage).toBe(0);
    expect(u.antiphishingStatus).toBe(false);
    expect(u.assetPasswordStatus).toBe(false);
    expect(u.changepassword).toBe(false);
    expect(u.isAff).toBe(false);
  });

  test("2FA starts completely empty, active AND pending", () => {
    const u = fresh();
    expect(u.google2Fa.secret).toBe("");
    expect(u.google2Fa.uri).toBe("");
    expect(u.google2Fa.pendingSecret).toBe("");
    expect(u.google2Fa.pendingUri).toBe("");
    expect(u.google2Fa.pendingCreatedAt).toBeNull();
  });

  test("deactivation state starts clear", () => {
    const u = fresh();
    expect(u.deactivatedAt).toBeNull();
    expect(u.deactiveOtpChannel).toBe("");
  });
});

describe("schema constraints", () => {
  test("userId is required and unique; email is unique", () => {
    expect(User.schema.path("userId").isRequired).toBe(true);
    expect(User.schema.path("userId").options.unique).toBe(true);
    expect(User.schema.path("email").options.unique).toBe(true);
  });

  test("a document with no userId fails validation", () => {
    const err = new User({ email: "a@b.co" }).validateSync();
    expect(err).toBeTruthy();
    expect(err.errors.userId).toBeTruthy();
  });

  test("`type` accepts exactly the shipped verification levels", () => {
    const allowed = User.schema.path("type").enumValues;
    expect(allowed).toEqual([
      "not_activate",
      "basic_pending",
      "basic_submitted",
      "basic_verified",
      "advanced_pending",
      "advanced_verified",
      "pro_pending",
      "pro_verified",
    ]);

    const bad = new User({ userId: "1", email: "a@b.co", type: "super_verified" });
    const err = bad.validateSync();
    expect(err.errors.type).toBeTruthy();
  });

  test("an empty hash is rejected by the shipped path validator", () => {
    // UserSchema.path("hash").validate(h => h.length, "Password cannot be blank")
    const u = new User({ userId: "1", email: "a@b.co", hash: "" });
    const err = u.validateSync();
    expect(err.errors.hash).toBeTruthy();
    expect(err.errors.hash.message).toBe("Password cannot be blank");
  });

  test("`deactiveOtpChannel` exists so the confirm step never trusts a client roleType", () => {
    expect(User.schema.path("deactiveOtpChannel")).toBeTruthy();
    expect(User.schema.path("deactivatedAt")).toBeTruthy();
  });

  /**
   * DEFECT, DOCUMENTED NOT FIXED - reported separately.
   *
   * auth.controller.createNewUser does `newUser["mailSentAt"] = new Date()` and
   * auth.controller.resendMail reads `userDoc.mailSentAt` to enforce a 3-minute
   * resend cooldown, and also branches on `userDoc.emailVerified`. Neither
   * field is on this schema, and mongoose is strict by default, so both
   * assignments are silently dropped and both reads are permanently undefined:
   * the cooldown on the UNAUTHENTICATED /api/auth/resend-mail endpoint never
   * fires.
   *
   * This test pins the current schema so the defect cannot be closed silently.
   */
  test("mailSentAt / emailVerified are NOT schema paths (the resend cooldown is dead code)", () => {
    expect(User.schema.path("mailSentAt")).toBeUndefined();
    expect(User.schema.path("emailVerified")).toBeUndefined();

    const u = new User({ userId: "1", email: "a@b.co" });
    u.mailSentAt = new Date();
    expect(u.toObject().mailSentAt).toBeUndefined();
  });
});

describe("virtuals and serialisation", () => {
  test("toObject/toJSON include virtuals, so `id` is present", () => {
    expect(User.schema.options.toObject.virtuals).toBe(true);
    expect(User.schema.options.toJSON.virtuals).toBe(true);
    const u = new User({ userId: "1", email: "a@b.co" });
    expect(u.toJSON().id).toBe(u._id.toString());
  });

  /**
   * DEFECT, DOCUMENTED NOT FIXED - reported separately.
   *
   * `password` is a virtual, so it is never PERSISTED - but because this schema
   * opts into `virtuals: true` for both toObject and toJSON, it IS emitted by
   * either serialiser for as long as the in-memory document holds the assigned
   * plaintext. Any `res.json(userDoc)` or `console.log(userDoc)` in the same
   * request as a password change would print the password.
   */
  test("the password virtual is not persisted, but IS emitted by toJSON while set", () => {
    const u = new User({ userId: "1", email: "a@b.co" });
    u.password = "SmokeTest123!";

    expect(u.password).toBe("SmokeTest123!");
    expect(u.toObject({ virtuals: false }).password).toBeUndefined();

    // Current behaviour, pinned:
    expect(u.toJSON().password).toBe("SmokeTest123!");
    expect(JSON.stringify(u.toJSON())).toContain("SmokeTest123!");
  });
});

describe("generateJWT", () => {
  test("returns a Bearer-prefixed token signed with the service secret", () => {
    const u = new User();
    const id = new mongoose.Types.ObjectId();
    const raw = u.generateJWT({ _id: id, role: "user", tokenId: "t1" });

    expect(raw.startsWith("Bearer ")).toBe(true);
    const decoded = jwt.verify(raw.slice(7), config.secretOrKey);
    expect(decoded._id).toBe(id.toString());
    expect(decoded.role).toBe("user");
    expect(decoded.tokenId).toBe("t1");
    expect(decoded.iat).toBeTruthy();
    expect(decoded.exp).toBeTruthy();
  });

  test("a token signed with any other secret does not verify", () => {
    const raw = new User().generateJWT({ _id: "x", role: "user" });
    expect(() => jwt.verify(raw.slice(7), "some-other-secret")).toThrow();
  });

  test("the payload is only signed, never encrypted", () => {
    // Anyone can read a JWT body. This is a reminder in test form: nothing
    // secret may be put in the payload.
    const raw = new User().generateJWT({ _id: "x", role: "user", tokenId: "t" });
    const body = JSON.parse(
      Buffer.from(raw.slice(7).split(".")[1], "base64").toString("utf8")
    );
    expect(body.role).toBe("user");
  });
});
