/**
 * AUTHENTICATION API - REAL INTEGRATION TESTS
 * ===========================================
 *
 * Every request below traverses the SHIPPED stack:
 *
 *   HTTP -> lib/responseGuard.js
 *        -> routes/auth.route.js
 *        -> validation/user.validation.js (registerValidate, loginValidate, ...)
 *        -> controllers/auth.controller.js
 *        -> models/User.js (real pbkdf2 hash/salt + authenticate())
 *        -> real mongo (mongodb-memory-server) + real redis (db 15, test prefix)
 *
 * Nothing about auth is simulated. The OTP a test types is the OTP the service
 * actually rendered into the actual email body; the bearer token a test uses is
 * the token the real login minted and the real passport strategy accepts.
 *
 * See tests/integration/integration-setup.js for what is stubbed and why.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "@jest/globals";

import {
  startHarness,
  stopHarness,
  resetState,
  api,
  getRealModules,
  boundaries,
  setBoundaryBehaviour,
  grpcCalls,
  mailsTo,
  waitFor,
  waitForMail,
  lastOtpFor,
  lastLinkTokenFor,
  loginViaApi,
  seedUser,
  seedUserSetting,
  seedUserKyc,
  seedSiteSetting,
  seedEmailTemplates,
  readSession,
  encryptId,
  decryptId,
  oid,
} from "./integration-setup.js";

import fs from "fs";
import path from "path";

const GOOD_PASSWORD = "SmokeTest123!";

/** The body registerValidate actually accepts. */
const registerBody = (over = {}) => ({
  roleType: 1,
  email: `reg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@example.com`,
  password: GOOD_PASSWORD,
  confirmPassword: GOOD_PASSWORD,
  ...over,
});

describe("Auth API (real router, real controllers)", () => {
  beforeAll(async () => {
    await startHarness();
  }, 120000);

  afterAll(async () => {
    await stopHarness();
  }, 60000);

  beforeEach(async () => {
    await resetState();
    await seedSiteSetting();
    await seedEmailTemplates();
  });

  // ------------------------------------------------------------------------
  // The harness itself. If these fail, nothing below means anything.
  // ------------------------------------------------------------------------
  describe("harness integrity", () => {
    test("the mounted router IS routes/auth.route.js", async () => {
      const { authRouter } = getRealModules();
      const paths = authRouter._router.stack
        .filter((l) => l.route)
        .map((l) => l.route.path);
      expect(paths).toEqual(
        expect.arrayContaining([
          "/register",
          "/login",
          "/resend-otp",
          "/forgotPassword",
          "/resetPassword",
          "/confirm-mail",
        ])
      );
    });

    test("a route the real router does not declare is a 404, not a fixture reply", async () => {
      const res = await api().post("/api/auth/definitely-not-a-real-route").send({});
      expect(res.status).toBe(404);
    });

    test("redis is db 15 under the isolated test prefix", async () => {
      const { redisCtrl } = getRealModules();
      await redisCtrl.hset("harnessProbe", "k", { v: 1 });
      const raw = await redisCtrl.hget("harnessProbe", "k");
      expect(JSON.parse(raw)).toEqual({ v: 1 });
      expect(process.env.REDIS_URL).toBe("redis://127.0.0.1:6379/15");
      expect(process.env.REDIS_PREFIX).toBe("cryptodex_itest_user_");
    });
  });

  // ------------------------------------------------------------------------
  // POST /api/auth/register  ->  registerValidate + authCtrl.createNewUser
  // ------------------------------------------------------------------------
  /**
   * THE CONTRACT BETWEEN THE REGISTER FORM AND registerValidate.
   *
   * Every other test in this file posts `registerBody()` - a hand-maintained
   * literal. That is a copy of the frontend's payload, and a copy cannot fail
   * when the original changes. It did change: the terms checkbox was removed
   * from the form, `registerValidate` still demanded it, and every single
   * registration from the real UI answered 400 with
   * {"errors":{"checkbox":"You need to accept the terms and conditions"}}.
   * Nothing here caught it, because `registerBody` still supplied the field
   * the form had stopped sending.
   *
   * So this one does not hand-maintain anything: it reads the key list out of
   * the object the form actually hands to apiSignUp and posts exactly those
   * keys. Add a required field to the validator without adding it to the form,
   * or drop one from the form that the validator still demands, and this fails.
   */
  describe("the register form's real payload satisfies the real validator", () => {
    const FORM = path.join(
      __dirname,
      "../../../cryptodex-frontend/components/Register/EmailForm.tsx"
    );

    /** The keys of the object literal passed to apiSignUp, read from source. */
    const payloadKeysFromForm = () => {
      const src = fs.readFileSync(FORM, "utf8");
      const call = src.indexOf("apiSignUp(data)");
      expect(call).toBeGreaterThan(-1);
      const open = src.lastIndexOf("let data = {", call);
      expect(open).toBeGreaterThan(-1);
      const close = src.indexOf("};", open);
      const body = src.slice(open + "let data = {".length, close);
      return body
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => l.split(":")[0].replace(",", "").trim())
        .filter((k) => /^[A-Za-z_$][\w$]*$/.test(k));
    };

    test("the form and the validator have not drifted apart", async () => {
      const keys = payloadKeysFromForm();
      // Sanity: if the parse silently returned nothing, the test would pass by
      // posting an empty body, so assert it found the shape we expect.
      expect(keys).toEqual(
        expect.arrayContaining(["email", "password", "confirmPassword", "roleType"])
      );

      const values = {
        email: `formcontract_${Date.now()}@example.com`,
        roleType: 1,
        password: GOOD_PASSWORD,
        confirmPassword: GOOD_PASSWORD,
        reCaptcha: "",
        refferalCode: "",
      };
      const body = {};
      for (const k of keys) {
        expect(Object.prototype.hasOwnProperty.call(values, k)).toBe(true);
        body[k] = values[k];
      }

      const res = await api().post("/api/auth/register").send(body);
      // The contract is only that no FIELD is rejected. A duplicate-email or
      // mail-transport failure is a different concern and would be a 400 with
      // some other key, so assert on the errors object rather than the status.
      expect(res.body.errors || {}).toEqual({});
      expect(res.status).toBe(200);
    });
  });

  describe("POST /api/auth/register", () => {
    test("real registerValidate rejects a missing email with its own message", async () => {
      const res = await api()
        .post("/api/auth/register")
        .send(registerBody({ email: "" }));
      expect(res.status).toBe(400);
      expect(res.body.errors.email).toBe("Email field is required");
    });

    test("real registerValidate rejects a password with no special character", async () => {
      // The shipped regex demands digit + upper + lower + non-word, 6..18.
      const res = await api()
        .post("/api/auth/register")
        .send(registerBody({ password: "Abcdef12", confirmPassword: "Abcdef12" }));
      expect(res.status).toBe(400);
      expect(res.body.errors.password).toMatch(/special character/i);
    });

    test("real registerValidate rejects mismatched confirmation", async () => {
      const res = await api()
        .post("/api/auth/register")
        .send(registerBody({ confirmPassword: "Different1!" }));
      expect(res.status).toBe(400);
      expect(res.body.errors.confirmPassword).toBe("Passwords must match");
    });

    test("a valid registration writes a REAL User with a pbkdf2 hash and mails a working activation link", async () => {
      const { models } = getRealModules();
      const body = registerBody();

      const res = await api().post("/api/auth/register").send(body);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(true);
      // THE REPLY REPORTS WHETHER ANYTHING WAS ACTUALLY SENT.
      // This asserted the fixed sentence "Activation mail sent...", which the
      // register form then dressed with "Check your spam folder if it does not
      // arrive." Under NODE_ENV=test - and under TEST_MODE=true, which is how
      // the local stack runs - `mailDeliveryMode()` is `log-only`: the mail is
      // rendered, the link is logged, and the provider is never contacted. So
      // that sentence, and the spam-folder advice built on it, described a
      // message that had deliberately not been dispatched.
      // `delivered` is now the fact, and the wording follows it.
      expect(res.body.mailDelivery).toBe("log-only");
      expect(res.body.delivered).toBe(false);
      expect(res.body.message).toMatch(/no email was sent/i);
      expect(res.body.message).not.toMatch(/spam/i);
      // ...AND THE LINK COMES BACK, because "it is in the server log" is honest
      // but is not a door: a browser cannot read the server log, so a user
      // could create an account here and never be able to activate it.
      expect(typeof res.body.activationLink).toBe("string");
      expect(res.body.activationLink).toContain("/verification/register?auth=");

      const user = await models.User.findOne({ email: body.email });
      expect(user).toBeTruthy();
      // The password is NEVER stored, and the hash is the model's pbkdf2 output.
      expect(user.hash).toBeTruthy();
      expect(user.salt).toBeTruthy();
      expect(user.hash).not.toContain(GOOD_PASSWORD);
      expect(user.authenticate(GOOD_PASSWORD)).toBe(true);
      expect(user.authenticate("wrong-password")).toBe(false);
      expect(user.status).toBe("unverified");
      expect(user.emailStatus).toBe("unverified");
      // userId / refferalCode are derived from the ObjectId by IncCntObjId.
      expect(user.userId).toBeTruthy();
      expect(user.refferalCode).toBe(user.userId);

      // The activation token in the mail decrypts back to this user's id.
      await waitForMail(body.email, 1);
      const token = lastLinkTokenFor(body.email);
      expect(token).toBeTruthy();
      expect(decryptId(token)).toBe(user._id.toString());
      expect(user.mailToken).toBe(token);
    });

    test("registration provisions the side effects the account depends on", async () => {
      const { models, redisCtrl } = getRealModules();
      const body = registerBody();
      await api().post("/api/auth/register").send(body).expect(200);

      const user = await models.User.findOne({ email: body.email });

      // Real mongo documents, created by the real controllers.
      //
      // Registration no longer creates a UserKyc document - KYC has been
      // removed from this venue - and that mattered enough to check here: the
      // gRPC `fetchUser` used to read `kycData.idProof.status` unconditionally,
      // so leaving the read in place while stopping the write would have thrown
      // for every account registered from that point on.
      await waitFor(async () => models.UserSetting.findById(user._id));
      expect(await models.UserSetting.findById(user._id)).toBeTruthy();
      expect(await models.UserKyc.findById(user._id)).toBeNull();

      // Real redis hash, written through the real redis controller.
      const settings = await redisCtrl.hgetall(`userSetting_${user._id}`);
      expect(settings).toMatchObject({ enableCryptodexFee: "false" });
      // `isAff` is not written any more - the affiliate programme is gone.
      expect(settings.isAff).toBeUndefined();

      // The two cross-service calls, at the boundary.
      const asset = grpcCalls("newAsset");
      expect(asset).toHaveLength(1);
      expect(asset[0].body).toMatchObject({ userCode: user.userId });
      // createRef() went to the affiliate api on :3008, which no longer exists.
      // newAsset is now the ONLY cross-service call registration makes.
      expect(grpcCalls("createRef")).toHaveLength(0);
      expect(boundaries().grpc.map((c) => c.method)).toEqual(["newAsset"]);
    });

    test("a second registration on a VERIFIED address is refused", async () => {
      const existing = await seedUser({ email: "taken@example.com" });
      expect(existing.emailStatus).toBe("verified");

      const res = await api()
        .post("/api/auth/register")
        .send(registerBody({ email: "taken@example.com" }));
      expect(res.status).toBe(400);
      expect(res.body.errors.email).toBe("Email already exists");
    });

    test("a recent UNVERIFIED registration is held for the remainder of 24h, not replaced", async () => {
      const body = registerBody();
      await api().post("/api/auth/register").send(body).expect(200);

      const res = await api().post("/api/auth/register").send(body);
      expect(res.status).toBe(400);
      expect(res.body.errors.email).toMatch(/unverified account exists/i);
      expect(res.body.errors.email).toMatch(/wait 24 hour/i);
    });

    test("an unverified registration older than 24h is deleted and re-issued", async () => {
      const { models } = getRealModules();
      const body = registerBody();
      await api().post("/api/auth/register").send(body).expect(200);
      const first = await models.User.findOne({ email: body.email });

      await models.User.updateOne(
        { _id: first._id },
        { $set: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } }
      );

      const res = await api().post("/api/auth/register").send(body);
      expect(res.status).toBe(200);
      const second = await models.User.findOne({ email: body.email });
      expect(second._id.toString()).not.toBe(first._id.toString());
      expect(await models.User.countDocuments({ email: body.email })).toBe(1);
    });

    // THE AFFILIATE PROGRAMME HAS BEEN WITHDRAWN.
    //
    // These two tests used to pin the opposite contract: an unknown code was a
    // 500 that aborted the whole registration, and a known code wrote a
    // Referral row, set refferedBy/parentId/isAff and fired createRef at
    // :3008. All of that is gone, so what has to be pinned now is that a
    // `refferalCode` in the body cannot do ANY of it - including that it can no
    // longer refuse a legitimate registration.
    test("an unknown referral code no longer refuses the registration", async () => {
      const { models } = getRealModules();
      const body = registerBody({ refferalCode: "NOSUCHCODE" });
      const res = await api().post("/api/auth/register").send(body);
      expect(res.status).toBe(200);
      expect(await models.User.findOne({ email: body.email })).toBeTruthy();
    });

    test("a referral code creates no link, no ledger row and no affiliate call", async () => {
      const { models, redisCtrl } = getRealModules();
      const referrer = await seedUser({ email: "referrer@example.com" });

      const body = registerBody({ refferalCode: referrer.userId });
      await api().post("/api/auth/register").send(body).expect(200);

      const referee = await models.User.findOne({ email: body.email });
      // Vestigial User paths: still on the schema so mongoose strict mode
      // cannot silently strip them off the accounts that already carry them,
      // but never written by this service again.
      expect(referee.refferedBy).toBeFalsy();
      expect(referee.parentId).toBeFalsy();
      expect(referee.isAff).toBe(false);

      // The Referral model itself has been deleted.
      expect(models.Referral).toBeUndefined();
      expect(
        await models.User.db.collection("Referral").countDocuments({
          refereeId: referee._id,
        })
      ).toBe(0);

      const settings = await redisCtrl.hgetall(`userSetting_${referee._id}`);
      expect(settings.isAff).toBeUndefined();

      expect(grpcCalls("createRef")).toHaveLength(0);
    });

    test("an unsupported roleType ANSWERS instead of hanging the connection", async () => {
      // This is the terminal branch called out in createNewUser: an
      // unauthenticated request that used to fall off the end of the handler
      // without ever calling res.*, holding the socket open.
      const res = await api().post("/api/auth/register").send({ roleType: 7 });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Unsupported registration type");
    });

    test("phone registration is refused with its own message", async () => {
      const res = await api()
        .post("/api/auth/register")
        .send({ roleType: 2, newPhoneNo: "5551234", newPhoneCode: "1", password: "x", confirmPassword: "x" });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Phone registration is disabled/i);
    });
  });

  // ------------------------------------------------------------------------
  // POST /api/auth/confirm-mail
  // ------------------------------------------------------------------------
  describe("POST /api/auth/confirm-mail", () => {
    test("the token from the registration email verifies the account exactly once", async () => {
      const { models } = getRealModules();
      const body = registerBody();
      await api().post("/api/auth/register").send(body).expect(200);
      await waitForMail(body.email, 1);
      const token = lastLinkTokenFor(body.email);

      const ok = await api().post("/api/auth/confirm-mail").send({ userId: token });
      expect(ok.status).toBe(200);
      expect(ok.body.success).toBe(true);

      const user = await models.User.findOne({ email: body.email });
      expect(user.status).toBe("verified");
      expect(user.emailStatus).toBe("verified");
      expect(user.percentage).toBe(25);

      // The socket fan-out the frontend listens on.
      expect(
        boundaries().socket.some(
          (e) => e.type === "registerVerify" && e.data.userId === user._id.toString()
        )
      ).toBe(true);

      // The token is BURNED on use. It used to be left on the document, so the
      // live activation link stayed valid on the account for ever and the only
      // thing refusing a replay was the `status == "unverified"` test.
      expect(user.mailToken).toBe("");

      // Replaying the same link is refused - and now says what is actually
      // true, "already activated", rather than blaming an expiry that did not
      // happen. The user needs to know to go and log in.
      const replay = await api()
        .post("/api/auth/confirm-mail")
        .send({ userId: token });
      expect(replay.status).toBe(400);
      expect(replay.body.message).toMatch(/already activated/i);
      expect(replay.body.status).toBe("failed");
    });

    test("a token for one account cannot verify another", async () => {
      const { models } = getRealModules();
      const victim = await seedUser({
        email: "victim@example.com",
        status: "unverified",
        emailStatus: "unverified",
      });
      // A well-formed token that the victim never received.
      const forged = encryptId(victim._id.toString());

      const res = await api().post("/api/auth/confirm-mail").send({ userId: forged });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/expired/i);
      const after = await models.User.findById(victim._id);
      expect(after.status).toBe("unverified");
    });

    test("the real validator rejects a missing token", async () => {
      const res = await api().post("/api/auth/confirm-mail").send({});
      expect(res.status).toBe(400);
      expect(res.body.errors.userId).toBeTruthy();
    });

    /**
     * A LINK THE USER BROKE IS NOT A SERVER FAULT.
     * -------------------------------------------
     * `decryptString` swallows its error and returns "", so a truncated or
     * mistyped token reached mongoose as `_id: ""` and threw a CastError; a
     * token that decrypted to some other id found no user and threw on
     * `null.mailToken`. Both were caught into HTTP 500 "Error on server",
     * which the verification page rendered verbatim - the product blaming
     * itself for a link a mail client cut short.
     */
    test.each([
      ["a truncated token", "U2FsdGVkX1"],
      ["a mistyped token", "not-a-real-token"],
      ["a token of punctuation", "%%%%"],
    ])("%s answers 400 with an explanation, never 500", async (_name, token) => {
      const res = await api().post("/api/auth/confirm-mail").send({ userId: token });
      expect(res.status).toBe(400);
      expect(res.body.message).not.toMatch(/error on server/i);
      expect(res.body.message).toMatch(/link/i);
      expect(res.body.status).toBe("failed");
    });

    test("a well-formed token for an account that no longer exists is 400, not 500", async () => {
      const res = await api()
        .post("/api/auth/confirm-mail")
        .send({ userId: encryptId(oid().toString()) });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/does not match any account/i);
    });
  });

  // ------------------------------------------------------------------------
  // POST /api/auth/login  ->  loginValidate + authCtrl.userLogin
  // ------------------------------------------------------------------------
  describe("POST /api/auth/login", () => {
    const seedLoginReadyUser = async (over = {}) => {
      const user = await seedUser({ email: "login@example.com", ...over });
      await seedUserSetting(user);
      await seedUserKyc(user);
      return user;
    };

    test("real loginValidate rejects a missing password", async () => {
      const res = await api()
        .post("/api/auth/login")
        .send({ roleType: 1, email: "login@example.com" });
      expect(res.status).toBe(400);
      expect(res.body.errors.password).toBe("Password field is required");
    });

    test("an unknown address is refused", async () => {
      const res = await api()
        .post("/api/auth/login")
        .send({ roleType: 1, email: "nobody@example.com", password: GOOD_PASSWORD });
      expect(res.status).toBe(400);
      expect(res.body.errors.email).toBe("Please enter a correct email address");
    });

    test("an unverified account cannot log in", async () => {
      await seedLoginReadyUser({ status: "unverified" });
      const res = await api()
        .post("/api/auth/login")
        .send({ roleType: 1, email: "login@example.com", password: GOOD_PASSWORD });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/still not activated/i);
    });

    test("a wrong password is refused by REAL pbkdf2 and counts an attempt", async () => {
      const { models } = getRealModules();
      const user = await seedLoginReadyUser();

      const res = await api()
        .post("/api/auth/login")
        .send({ roleType: 1, email: "login@example.com", password: "Wrong123!" });
      expect(res.status).toBe(400);
      expect(res.body.errors.password).toBe("Password incorrect");

      const after = await models.User.findById(user._id);
      expect(after.login_attempt).toBe(1);
      expect(after.isBlock).toBe(false);
      // No session was minted.
      expect(await readSession(user._id)).toBeNull();
    });

    test("the third consecutive wrong password blocks the account for 24h", async () => {
      const { models } = getRealModules();
      const user = await seedLoginReadyUser();
      const bad = () =>
        api()
          .post("/api/auth/login")
          .send({ roleType: 1, email: "login@example.com", password: "Wrong123!" });

      expect((await bad()).status).toBe(400);
      expect((await bad()).status).toBe(400);
      const third = await bad();
      expect(third.status).toBe(405);
      expect(third.body.message).toMatch(/too many login attempts/i);

      const blocked = await models.User.findById(user._id);
      expect(blocked.isBlock).toBe(true);
      expect(blocked.login_attempt).toBe(0);

      // Even the CORRECT password is refused while the block stands.
      const correct = await api()
        .post("/api/auth/login")
        .send({ roleType: 1, email: "login@example.com", password: GOOD_PASSWORD });
      expect(correct.status).toBe(405);
      expect(await readSession(user._id)).toBeNull();
    });

    test("a block older than 24h is cleared and the login proceeds", async () => {
      const { models } = getRealModules();
      const user = await seedLoginReadyUser();
      await models.User.updateOne(
        { _id: user._id },
        {
          $set: {
            isBlock: true,
            lock_session: new Date(Date.now() - 25 * 60 * 60 * 1000),
          },
        }
      );

      const res = await api()
        .post("/api/auth/login")
        .send({ roleType: 1, email: "login@example.com", password: GOOD_PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("OTP");
      expect((await models.User.findById(user._id)).isBlock).toBe(false);
    });

    test("step 1 mails a 6-digit OTP and mints NO session", async () => {
      const { models } = getRealModules();
      const user = await seedLoginReadyUser();

      const res = await api()
        .post("/api/auth/login")
        .send({ roleType: 1, email: "login@example.com", password: GOOD_PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("OTP");
      expect(res.body.token).toBeUndefined();
      expect(await readSession(user._id)).toBeNull();

      await waitForMail("login@example.com", 1);
      const otp = lastOtpFor("login@example.com");
      expect(otp).toMatch(/^\d{6}$/);
      // The code in the mail is the code the service stored.
      const stored = await models.User.findById(user._id);
      expect(String(stored.otp)).toBe(otp);
    });

    /**
     * THE FRONT DOOR HAS THE SAME FAILURE MODE AS THE RECOVERY SURFACES.
     * =================================================================
     * The login code branch is skipped entirely when TEST_MODE=true - how the
     * live venue runs - so it does not bite there. But `mailDeliveryMode` also
     * goes log-only on DEV_EMAIL_BYPASS=true ALONE, and the skip in userLogin
     * does not consult that flag. On such a run registration, password reset
     * and password change would all work and LOGIN would be impossible: a code
     * demanded, and mailed by a gateway that only writes to a log.
     *
     * Keyed off the same delivery signal as every other surface. The password
     * has already been verified when this reply is written, so the second
     * factor is disclosed only to someone who passed the first.
     */
    test("with delivery off, step 1 says so and returns the code it could not send", async () => {
      const { models } = getRealModules();
      const user = await seedLoginReadyUser();

      const res = await api()
        .post("/api/auth/login")
        .send({ roleType: 1, email: "login@example.com", password: GOOD_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("OTP");
      expect(res.body.delivered).toBe(false);
      expect(res.body.message).toMatch(/no email was sent/i);
      expect(res.body.verificationCode).toMatch(/^\d{6}$/);
      // Still no session, and the code is the one that was stored.
      expect(res.body.token).toBeUndefined();
      expect(await readSession(user._id)).toBeNull();
      expect(String((await models.User.findById(user._id)).otp)).toBe(
        res.body.verificationCode
      );

      // And it completes the sign-in, which is the point.
      const second = await api().post("/api/auth/login").send({
        roleType: 1,
        email: "login@example.com",
        password: GOOD_PASSWORD,
        otpTextBox: true,
        otp: res.body.verificationCode,
      });
      expect(second.status).toBe(200);
      expect(second.body.token).toBeTruthy();
    });

    test("a WRONG password discloses nothing at all (SECURITY)", async () => {
      // The disclosure must sit behind the password check, not in front of it.
      await seedLoginReadyUser();
      const res = await api()
        .post("/api/auth/login")
        .send({ roleType: 1, email: "login@example.com", password: "not-the-password" });
      expect(res.status).not.toBe(200);
      expect(res.body.verificationCode).toBeUndefined();
    });

    test("step 2 with a WRONG OTP is refused", async () => {
      const user = await seedLoginReadyUser();
      await api()
        .post("/api/auth/login")
        .send({ roleType: 1, email: "login@example.com", password: GOOD_PASSWORD })
        .expect(200);
      await waitForMail("login@example.com", 1);
      const otp = lastOtpFor("login@example.com");
      const wrong = String((Number(otp) + 1) % 1000000).padStart(6, "0");

      const res = await api().post("/api/auth/login").send({
        roleType: 1,
        email: "login@example.com",
        password: GOOD_PASSWORD,
        otpTextBox: true,
        otp: wrong,
      });
      expect(res.status).toBe(400);
      expect(res.body.errors.otp).toBe("Invalid OTP");
      expect(await readSession(user._id)).toBeNull();
    });

    test("step 2 with an EXPIRED OTP is refused", async () => {
      const { models } = getRealModules();
      const user = await seedLoginReadyUser();
      await api()
        .post("/api/auth/login")
        .send({ roleType: 1, email: "login@example.com", password: GOOD_PASSWORD })
        .expect(200);
      await waitForMail("login@example.com", 1);
      const otp = lastOtpFor("login@example.com");

      // The shipped window is 3.4 minutes for email.
      await models.User.updateOne(
        { _id: user._id },
        { $set: { otptime: new Date(Date.now() - 4 * 60 * 1000) } }
      );

      const res = await api().post("/api/auth/login").send({
        roleType: 1,
        email: "login@example.com",
        password: GOOD_PASSWORD,
        otpTextBox: true,
        otp,
      });
      expect(res.status).toBe(400);
      expect(res.body.errors.otp).toBe("OTP Expired");
    });

    test("step 2 with the mailed OTP mints a session that the REAL passport strategy accepts", async () => {
      const { models } = getRealModules();
      const user = await seedLoginReadyUser();

      const { response, otp, token } = await loginViaApi(
        "login@example.com",
        GOOD_PASSWORD,
        { loginHistory: { ipaddress: "127.0.0.1", broswername: "itest", countryName: "Nowhere" } }
      );
      expect(otp).toMatch(/^\d{6}$/);
      expect(response.status).toBe(200);
      expect(response.body.status).toBe("SUCCESS");
      expect(token).toMatch(/^Bearer /);

      // The session redis row the passport strategy reads.
      const session = await readSession(user._id);
      expect(session).toBeTruthy();
      expect(session.email).toBe("login@example.com");
      expect(session.userLocked).toBe("false");
      expect(session.tokenId).toBeTruthy();

      // And it really works against a guarded route.
      const profile = await api()
        .get("/api/user/profile")
        .set("Authorization", token);
      expect(profile.status).toBe(200);
      expect(profile.body.result.email).toBe("login@example.com");

      // The counters were reset. NOTHING is journalled any more: the
      // LoginHistory collection went with the login-history screens, so the
      // session row asserted above - the thing passport actually reads - is
      // the whole of what a successful login now writes.
      const after = await models.User.findById(user._id);
      expect(after.login_attempt).toBe(0);
      expect(after.isBlock).toBe(false);
      expect(String(after.otp)).toBe("");
      expect(await models.LoginHistory.findOne({ userId: user._id })).toBeNull();
    });

    test("a token signed with the wrong secret is rejected by the real strategy", async () => {
      const jwt = (await import("jsonwebtoken")).default;
      const user = await seedLoginReadyUser();
      const forged = jwt.sign(
        { _id: user._id.toString(), role: "user", tokenId: "anything" },
        "not-the-real-secret",
        { expiresIn: "1h" }
      );
      const res = await api()
        .get("/api/user/profile")
        .set("Authorization", `Bearer ${forged}`);
      expect(res.status).toBe(401);
    });

    // THE LOGIN IP BLOCKLIST IS GONE, so this asserts the inverse. It was
    // administered through /api/admin/IpRestriction, which was removed with the
    // rest of the security surface; a row in that collection is now inert. If
    // the check is ever reinstated without its admin screen, this fails and
    // names the reason.
    test("a row in the old IP blocklist no longer refuses a login", async () => {
      const { models } = getRealModules();
      await seedLoginReadyUser();
      await models.ipAddress.create({ ip: "10.9.9.9" });

      const res = await api().post("/api/auth/login").send({
        roleType: 1,
        email: "login@example.com",
        password: GOOD_PASSWORD,
        loginHistory: { ipaddress: "10.9.9.9" },
      });
      expect(res.status).not.toBe(500);
      expect(JSON.stringify(res.body)).not.toMatch(/Ip has been Blocked/i);
    });
  });

  // ------------------------------------------------------------------------
  // Password reset: forgotPassword -> resetconfirmMail -> resetPassword
  // ------------------------------------------------------------------------
  describe("password reset flow", () => {
    const seedResetUser = async (over = {}) => {
      const user = await seedUser({ email: "reset@example.com", ...over });
      await seedUserSetting(user);
      await seedUserKyc(user);
      return user;
    };

    test("an unknown address is refused", async () => {
      const res = await api()
        .post("/api/auth/forgotPassword")
        .send({ roleType: 1, email: "nobody@example.com" });
      expect(res.status).toBe(400);
      expect(res.body.errors.email).toBe("Email does not exist");
    });

    test("an unverified account cannot start a reset", async () => {
      await seedResetUser({ status: "unverified" });
      const res = await api()
        .post("/api/auth/forgotPassword")
        .send({ roleType: 1, email: "reset@example.com" });
      expect(res.status).toBe(400);
      expect(res.body.errors.email).toMatch(/still not activated/i);
    });

    test("the whole reset actually changes the password", async () => {
      const { models } = getRealModules();
      const user = await seedResetUser();

      // 1. request
      const forgot = await api()
        .post("/api/auth/forgotPassword")
        .send({ roleType: 1, email: "reset@example.com" });
      expect(forgot.status).toBe(200);
      await waitForMail("reset@example.com", 1);
      const authToken = lastLinkTokenFor("reset@example.com");
      expect(decryptId(authToken)).toBe(user._id.toString());

      // 2. confirm the link
      const confirm = await api()
        .post("/api/auth/resetconfirmMail")
        .send({ authToken });
      expect(confirm.status).toBe(200);
      const mid = await models.User.findById(user._id);
      expect(mid.mailToken).toBe("");
      expect(mid.conFirmMailToken).toBe(authToken);

      // 3. set the new password
      const NEW = "Rotated456!";
      const reset = await api()
        .post("/api/auth/resetPassword")
        .send({ authToken, password: NEW, confirmPassword: NEW });
      expect(reset.status).toBe(200);

      const after = await models.User.findById(user._id);
      expect(after.authenticate(NEW)).toBe(true);
      expect(after.authenticate(GOOD_PASSWORD)).toBe(false);
      expect(after.conFirmMailToken).toBe("");

      // And the change is visible through the real login.
      const oldTry = await api()
        .post("/api/auth/login")
        .send({ roleType: 1, email: "reset@example.com", password: GOOD_PASSWORD });
      expect(oldTry.status).toBe(400);
      const newTry = await api()
        .post("/api/auth/login")
        .send({ roleType: 1, email: "reset@example.com", password: NEW });
      expect(newTry.status).toBe(200);
      expect(newTry.body.status).toBe("OTP");
    });

    /**
     * THE DEFECT THIS BLOCK EXISTS FOR.
     * ================================
     * /forgotPassword answered "Reset password link sent to registered mail ID"
     * unconditionally. Under log-only delivery - which is how this venue runs,
     * and how the suite runs (NODE_ENV=test) - nothing was sent; the link went
     * to the process log. It is the ONLY route back into an account whose
     * password is forgotten, so a locked-out user was locked out permanently,
     * having been told help was on the way.
     *
     * Two properties are pinned: the message must not claim a send that did
     * not happen, and the link the caller is given must be the SAME token the
     * mail carried - a decorative link that does not actually work would be a
     * second version of the same lie.
     */
    test("with delivery off, forgotPassword says so and returns a link that really works", async () => {
      const { models } = getRealModules();
      const user = await seedResetUser();

      const forgot = await api()
        .post("/api/auth/forgotPassword")
        .send({ roleType: 1, email: "reset@example.com" });

      expect(forgot.status).toBe(200);
      expect(forgot.body.success).toBe(true);
      // Nothing was sent, so nothing may claim it was.
      expect(forgot.body.delivered).toBe(false);
      expect(forgot.body.message).not.toMatch(/sent to registered mail/i);
      expect(forgot.body.message).toMatch(/no email was sent/i);

      // And the way forward is in the reply.
      expect(typeof forgot.body.resetLink).toBe("string");
      expect(forgot.body.resetLink).toContain("/verification/forgotPassword?auth=");

      // The link is the real one: same token as the mail, and it drives the
      // rest of the reset to completion.
      // Wait for the LINK, not merely for a mail. Every mail in this service
      // is dispatched without await, so the login-notification mail the
      // previous test triggered can land after `resetState` and satisfy a bare
      // count while the reset mail is still in flight.
      const mailedToken = await waitFor(() => lastLinkTokenFor("reset@example.com"));
      const linkToken = forgot.body.resetLink.split("auth=")[1];
      expect(linkToken).toBe(mailedToken);
      expect(decryptId(linkToken)).toBe(user._id.toString());

      await api()
        .post("/api/auth/resetconfirmMail")
        .send({ authToken: linkToken })
        .expect(200);
      const NEW = "FromTheLink1!";
      await api()
        .post("/api/auth/resetPassword")
        .send({ authToken: linkToken, password: NEW, confirmPassword: NEW })
        .expect(200);

      const after = await models.User.findById(user._id);
      expect(after.authenticate(NEW)).toBe(true);
    });

    test("a confirmed reset link older than the 30-min TTL is refused", async () => {
      const { models } = getRealModules();
      const user = await seedResetUser();
      await api()
        .post("/api/auth/forgotPassword")
        .send({ roleType: 1, email: "reset@example.com" })
        .expect(200);
      await waitForMail("reset@example.com", 1);
      const authToken = lastLinkTokenFor("reset@example.com");
      await api().post("/api/auth/resetconfirmMail").send({ authToken }).expect(200);

      // age the request past the reset TTL (otptime is stamped at request time)
      await models.User.updateOne(
        { _id: user._id },
        { $set: { otptime: new Date(Date.now() - 31 * 60 * 1000) } }
      );

      const reset = await api()
        .post("/api/auth/resetPassword")
        .send({ authToken, password: "Rotated456!", confirmPassword: "Rotated456!" });
      expect(reset.status).toBe(400);
      expect(reset.body.message).toMatch(/expired/i);
      // the password is unchanged
      const after = await models.User.findById(user._id);
      expect(after.authenticate(GOOD_PASSWORD)).toBe(true);
    });

    test("re-requesting a reset revokes a previously confirmed token", async () => {
      const { models } = getRealModules();
      const user = await seedResetUser();
      // request A + confirm A
      await api()
        .post("/api/auth/forgotPassword")
        .send({ roleType: 1, email: "reset@example.com" })
        .expect(200);
      await waitForMail("reset@example.com", 1);
      const tokenA = lastLinkTokenFor("reset@example.com");
      await api().post("/api/auth/resetconfirmMail").send({ authToken: tokenA }).expect(200);
      expect((await models.User.findById(user._id)).conFirmMailToken).toBe(tokenA);

      // request B (do not confirm) must clear A's confirmed status
      await api()
        .post("/api/auth/forgotPassword")
        .send({ roleType: 1, email: "reset@example.com" })
        .expect(200);
      expect((await models.User.findById(user._id)).conFirmMailToken).toBe("");

      // resetting with the old confirmed token A is now refused
      const reset = await api()
        .post("/api/auth/resetPassword")
        .send({ authToken: tokenA, password: "Rotated456!", confirmPassword: "Rotated456!" });
      expect(reset.status).toBe(400);
      const after = await models.User.findById(user._id);
      expect(after.authenticate(GOOD_PASSWORD)).toBe(true);
    });

    test("resetconfirmMail refuses a broken link with 400, not 500", async () => {
      for (const token of ["U2FsdGVkX1", "nonsense", "%%%"]) {
        const res = await api().post("/api/auth/resetconfirmMail").send({ authToken: token });
        expect(res.status).toBe(400);
        expect(res.body.message).not.toMatch(/error on server/i);
        expect(res.body.message).toMatch(/link/i);
      }
    });

    test("resetPassword without the confirm step is refused", async () => {
      const user = await seedResetUser();
      const authToken = encryptId(user._id.toString());
      const res = await api()
        .post("/api/auth/resetPassword")
        .send({ authToken, password: "Rotated456!", confirmPassword: "Rotated456!" });
      expect(res.status).toBe(400);
      // Refused either by the confirm-step gate ("link expiry") or, with no fresh
      // otptime seeded, by the new reset-link TTL gate ("expired") - both correct.
      expect(res.body.message).toMatch(/expir(y|ed)/i);

      const { models } = getRealModules();
      const after = await models.User.findById(user._id);
      expect(after.authenticate(GOOD_PASSWORD)).toBe(true);
    });

    test("the confirm token is single-use", async () => {
      const user = await seedResetUser();
      await api()
        .post("/api/auth/forgotPassword")
        .send({ roleType: 1, email: "reset@example.com" })
        .expect(200);
      await waitForMail("reset@example.com", 1);
      const authToken = lastLinkTokenFor("reset@example.com");
      await api().post("/api/auth/resetconfirmMail").send({ authToken }).expect(200);

      const NEW = "Rotated456!";
      await api()
        .post("/api/auth/resetPassword")
        .send({ authToken, password: NEW, confirmPassword: NEW })
        .expect(200);

      const replay = await api()
        .post("/api/auth/resetPassword")
        .send({ authToken, password: "Third789!", confirmPassword: "Third789!" });
      expect(replay.status).toBe(400);

      const { models } = getRealModules();
      const after = await models.User.findById(user._id);
      expect(after.authenticate(NEW)).toBe(true);
      expect(after.authenticate("Third789!")).toBe(false);
    });

    test("the real resetPwdValidate rejects a weak new password", async () => {
      const res = await api()
        .post("/api/auth/resetPassword")
        .send({ authToken: "x", password: "abcdefg", confirmPassword: "abcdefg" });
      expect(res.status).toBe(400);
      expect(res.body.errors.password).toMatch(/uppercase/i);
    });

    test("an unsupported reset type ANSWERS instead of hanging", async () => {
      const res = await api().post("/api/auth/forgotPassword").send({ roleType: 9 });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Unsupported password reset type");
    });
  });

  // ------------------------------------------------------------------------
  // POST /api/auth/resend-otp
  //
  // POST /api/auth/verifyOtp IS GONE, and the three cases that covered it with
  // it. It was the PHONE code: `resend-otp` texted a six-digit code and
  // verifyOtp checked it, marking `phoneStatus` and `status` verified and, for
  // `optType: "forget"`, minting a password-reset token. Only the frontend's
  // three Mobile forms called it, the SMS send behind it had been commented out
  // for some time, and phone is gone from this venue.
  //
  // THE LOGIN CODE IS NOT THIS. It is mailed by POST /login and verified by the
  // second POST /login, both covered above, and re-issued by /resend-otp, which
  // is covered here.
  // ------------------------------------------------------------------------
  describe("OTP endpoints", () => {
    test("the phone verify endpoint is gone, not merely unauthorised", async () => {
      const res = await api()
        .post("/api/auth/verifyOtp")
        .send({ otpAuth: "x", otp: "123456" });
      expect(res.status).toBe(404);
    });

    test("resend-otp stores a fresh code and mails exactly that code", async () => {
      const { models } = getRealModules();
      const user = await seedUser({ email: "resend@example.com" });

      const res = await api()
        .post("/api/auth/resend-otp")
        .send({ roleType: 1, email: "resend@example.com" });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("RESEND_OTP");

      await waitForMail("resend@example.com", 1);
      const mailed = lastOtpFor("resend@example.com");
      await waitFor(async () => {
        const u = await models.User.findById(user._id);
        return String(u.otp) === mailed ? u : null;
      });
      const stored = await models.User.findById(user._id);
      expect(String(stored.otp)).toBe(mailed);
    });

    test("resend-otp on an unknown address is refused", async () => {
      const res = await api()
        .post("/api/auth/resend-otp")
        .send({ roleType: 1, email: "nobody@example.com" });
      expect(res.status).toBe(400);
      expect(res.body.errors.email).toBe("Please enter a correct email address");
    });
  });

  // ------------------------------------------------------------------------
  // POST /api/auth/resend-mail
  // ------------------------------------------------------------------------
  describe("POST /api/auth/resend-mail", () => {
    test("an unknown address is refused", async () => {
      const res = await api()
        .post("/api/auth/resend-mail")
        .send({ email: "nobody@example.com" });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("User not found");
    });

    test("it re-issues a working activation token", async () => {
      const { models } = getRealModules();
      const user = await seedUser({
        email: "resendmail@example.com",
        status: "unverified",
        emailStatus: "unverified",
      });

      const res = await api()
        .post("/api/auth/resend-mail")
        .send({ email: "resendmail@example.com" });
      expect(res.status).toBe(200);

      await waitForMail("resendmail@example.com", 1);
      const token = lastLinkTokenFor("resendmail@example.com");
      expect(decryptId(token)).toBe(user._id.toString());
      await waitFor(async () => {
        const u = await models.User.findById(user._id);
        return u.mailToken === token ? u : null;
      });
      expect((await models.User.findById(user._id)).mailToken).toBe(token);
    });

    /**
     * DEFECT, DOCUMENTED NOT FIXED - see the report accompanying this pass.
     *
     * resendMail implements a 3-minute cooldown by reading and writing
     * `userDoc.mailSentAt`, and createNewUser sets the same field. Neither
     * field exists on the User schema in models/User.js, and the schema is
     * strict, so the assignment is silently discarded and `userDoc.mailSentAt`
     * is always undefined. The cooldown branch is therefore dead code and this
     * unauthenticated endpoint will mail any registered address as fast as it
     * is called. This test PINS THE CURRENT BEHAVIOUR so the defect cannot be
     * "fixed" silently: when mailSentAt is added to the schema, this test goes
     * red and must be inverted to expect 429.
     */
    test("the 3-minute cooldown does NOT engage, because mailSentAt is not on the schema", async () => {
      const { models } = getRealModules();
      const user = await seedUser({
        email: "cooldown@example.com",
        status: "unverified",
        emailStatus: "unverified",
      });

      await api()
        .post("/api/auth/resend-mail")
        .send({ email: "cooldown@example.com" })
        .expect(200);
      const second = await api()
        .post("/api/auth/resend-mail")
        .send({ email: "cooldown@example.com" });

      expect(second.status).toBe(200); // would be 429 if the cooldown worked
      const stored = await models.User.findById(user._id);
      expect(stored.mailSentAt).toBeUndefined();
      expect(models.User.schema.path("mailSentAt")).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------------
  // POST /api/auth/test-verify - the shipped test backdoor, and its guard
  // ------------------------------------------------------------------------
  describe("POST /api/auth/test-verify", () => {
    test("verifies an account when the test-mode guard is satisfied", async () => {
      const { models } = getRealModules();
      const user = await seedUser({
        email: "tv@example.com",
        status: "unverified",
        emailStatus: "unverified",
      });
      const res = await api()
        .post("/api/auth/test-verify")
        .send({ email: "tv@example.com" });
      expect(res.status).toBe(200);
      expect((await models.User.findById(user._id)).status).toBe("verified");
    });

    test("is refused outside test mode", async () => {
      const prevNode = process.env.NODE_ENV;
      const prevTest = process.env.TEST_MODE;
      process.env.NODE_ENV = "staging";
      process.env.TEST_MODE = "false";
      try {
        const res = await api()
          .post("/api/auth/test-verify")
          .send({ email: "tv@example.com" });
        expect(res.status).toBe(403);
        expect(res.body.message).toMatch(/only available in test mode/i);
      } finally {
        process.env.NODE_ENV = prevNode;
        process.env.TEST_MODE = prevTest;
      }
    });

    test("is HARD-refused in production even if TEST_MODE=true leaks in", async () => {
      const prevNode = process.env.NODE_ENV;
      const prevTest = process.env.TEST_MODE;
      // The supervisor passes the parent env through, so a stray TEST_MODE=true
      // on a NODE_ENV=production box must NOT re-open this no-auth verify backdoor.
      process.env.NODE_ENV = "production";
      process.env.TEST_MODE = "true";
      try {
        const res = await api()
          .post("/api/auth/test-verify")
          .send({ email: "tv@example.com" });
        expect(res.status).toBe(403);
      } finally {
        process.env.NODE_ENV = prevNode;
        process.env.TEST_MODE = prevTest;
      }
    });
  });

  // ------------------------------------------------------------------------
  // ONE SPELLING OF AN EMAIL ADDRESS (CRITICAL)
  // ------------------------------------------------------------------------
  // `createNewUser` lowercases before it saves; login lowercases before it
  // looks up. Three other lookups did not, so anyone who typed a capital in
  // their own address at registration could log in and could never recover the
  // account - "Email does not exist" about a row that exists. The user schema
  // carries no `lowercase: true`, so mongoose applied no setter to the query.
  describe("an address with capitals resolves to the account it created", () => {
    const MIXED = "Mixed.Case@Example.COM";
    const STORED = "mixed.case@example.com";

    test("registration stores the lowercased spelling (the premise)", async () => {
      const { models } = getRealModules();
      await api()
        .post("/api/auth/register")
        .send(registerBody({ email: MIXED }))
        .expect(200);
      expect(await models.User.findOne({ email: STORED })).toBeTruthy();
      expect(await models.User.findOne({ email: MIXED })).toBeNull();
    });

    test("forgotPassword finds the account when the address is typed with capitals", async () => {
      await seedUser({
        email: STORED,
        status: "verified",
        emailStatus: "verified",
      });
      const res = await api()
        .post("/api/auth/forgotPassword")
        .send({ roleType: 1, email: MIXED });
      // The only wrong answer is "Email does not exist" about a row that does.
      expect(res.body?.errors?.email || "").not.toMatch(/does not exist/i);
      expect(res.status).toBe(200);
    });

    test("resend-mail finds the account when the address is typed with capitals", async () => {
      await seedUser({
        email: STORED,
        status: "unverified",
        emailStatus: "unverified",
      });
      const res = await api()
        .post("/api/auth/resend-mail")
        .send({ email: MIXED });
      expect(res.body?.message || "").not.toMatch(/user not found/i);
    });

    test("test-verify activates the account when the address is typed with capitals", async () => {
      const { models } = getRealModules();
      const user = await seedUser({
        email: STORED,
        status: "unverified",
        emailStatus: "unverified",
      });
      const res = await api()
        .post("/api/auth/test-verify")
        .send({ email: MIXED });
      expect(res.status).toBe(200);
      expect((await models.User.findById(user._id)).status).toBe("verified");
    });

    test("OVER-CORRECTION: a genuinely unknown address is still refused", async () => {
      // Normalising must not turn "no such user" into a match. All three
      // lookups must still answer "not found" for an address nobody registered.
      const nobody = "Nobody.Here@Example.COM";
      expect(
        (await api().post("/api/auth/forgotPassword").send({ roleType: 1, email: nobody }))
          .body?.errors?.email
      ).toMatch(/does not exist/i);
      expect(
        (await api().post("/api/auth/resend-mail").send({ email: nobody })).body
          ?.message
      ).toMatch(/user not found/i);
      expect(
        (await api().post("/api/auth/test-verify").send({ email: nobody })).status
      ).toBe(404);
    });

    test("OVER-CORRECTION: normalising is CASE only - two addresses differing by a dot stay distinct", async () => {
      // Case is the only thing registration folds. Anything more (trimming
      // dots gmail-style, stripping punctuation, a loose regex) makes one
      // account resolvable as another, which is worse than the bug it fixes.
      const { models } = getRealModules();
      const dotted = await seedUser({
        email: "a.b@example.com",
        status: "unverified",
        emailStatus: "unverified",
      });
      const plain = await seedUser({
        email: "ab@example.com",
        status: "unverified",
        emailStatus: "unverified",
      });

      await api().post("/api/auth/test-verify").send({ email: "A.B@Example.com" });

      expect((await models.User.findById(dotted._id)).status).toBe("verified");
      expect((await models.User.findById(plain._id)).status).toBe("unverified");
    });

    test("test-verify still refuses a request with no email at all", async () => {
      // normaliseEmail hands non-strings straight back so the existing `!email`
      // guard keeps firing instead of querying for the string "undefined".
      const res = await api().post("/api/auth/test-verify").send({});
      expect(res.status).toBe(400);
    });

    test("resend-mail with NO email selects nobody - it used to select anybody", async () => {
      // Mongoose strips undefined out of a filter, so `findOne({ email:
      // undefined })` is `findOne({})`: the route picked an arbitrary account
      // and overwrote its mailToken with a freshly issued one.
      const { models } = getRealModules();
      const victim = await seedUser({
        email: "victim@example.com",
        status: "unverified",
        emailStatus: "unverified",
        mailToken: "original-token",
      });

      const res = await api().post("/api/auth/resend-mail").send({});

      expect(res.status).toBe(400);
      // The MESSAGE matters, not just the status. Without the guard this route
      // still answers 400 - "User is already verified", about a stranger's
      // account it selected with an empty filter - and a test that only
      // asserted the status passed while the mutant was in place.
      expect(res.body.message).toMatch(/email is required/i);
      const after = await models.User.findById(victim._id);
      expect(after.mailToken).toBe("original-token");
      expect(after.mailSentAt).toBeUndefined();
      expect(mailsTo("victim@example.com")).toHaveLength(0);
    });

    // The REAL verification path is not affected, and that was checked rather
    // than assumed: `confirmMail` resolves the user from
    // `decryptString(reqBody.userId)` and looks them up by `_id`, comparing
    // `mailToken`. It never reads the email string, so activation in production
    // was never blocked by any of this. This test pins that, so a future
    // "let's look the user up by email here too" reintroduces the bug loudly.
    test("confirmMail activates a mixed-case registration - it never reads the email", async () => {
      const { models } = getRealModules();
      const user = await seedUser({
        email: STORED,
        status: "unverified",
        emailStatus: "unverified",
      });
      const token = encryptId(user._id.toString());
      await models.User.updateOne({ _id: user._id }, { $set: { mailToken: token } });

      const res = await api()
        .post("/api/auth/confirm-mail")
        .send({ userId: token });

      expect(res.status).toBe(200);
      expect((await models.User.findById(user._id)).status).toBe("verified");
    });
  });

  // ------------------------------------------------------------------------
  // Boundary refusals - the code that only runs when a peer is down.
  // ------------------------------------------------------------------------
  describe("cross-service boundaries", () => {
    test("registration still completes when walletapi's newAsset refuses", async () => {
      const { models } = getRealModules();
      setBoundaryBehaviour("newAsset", async () => ({
        status: false,
        error: "Error on Connection",
      }));
      const body = registerBody();
      const res = await api().post("/api/auth/register").send(body);
      expect(res.status).toBe(200);
      expect(await models.User.findOne({ email: body.email })).toBeTruthy();
    });

    test("no mail leaves the process when there is no template row", async () => {
      const { models } = getRealModules();
      await models.EmailTemplate.deleteMany({});
      const body = registerBody();
      await api().post("/api/auth/register").send(body).expect(200);
      // Give the fire-and-forget path a chance to (not) send.
      await new Promise((r) => setTimeout(r, 150));
      expect(mailsTo(body.email)).toHaveLength(0);
    });
  });
});
