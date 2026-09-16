/**
 * USER / ACCOUNT API - REAL INTEGRATION TESTS
 * ===========================================
 *
 * Every request traverses routes/user.route.js behind the REAL passport
 * "usersAuth" JWT strategy from config/passport.js - which resolves the caller
 * out of the redis `userToken` hash, exactly as the running service does - then
 * the real validators and the real controllers.
 *
 * The old fixture replaced passport with
 *   `req.user = testUsers.get(req.get('user-id'))`
 * and answered every one of these paths with a hard-coded
 * `{status:'success'}`, so none of the authorization below was ever tested.
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
  waitFor,
  waitForMail,
  lastOtpFor,
  seedUser,
  seedUserSetting,
  seedUserKyc,
  seedSiteSetting,
  seedEmailTemplates,
  issueSession,
  readSession,
  totpFor,
} from "./integration-setup.js";

const PASSWORD = "SmokeTest123!";

/** A complete, logged-in account: User + UserSetting + UserKyc + a session. */
async function seedAccount(over = {}) {
  const user = await seedUser({ email: `acct_${Math.random().toString(36).slice(2, 8)}@example.com`, ...over });
  const setting = await seedUserSetting(user, over.settings);
  await seedUserKyc(user);
  const session = await issueSession(user);
  return { user, setting, auth: session.authHeader, session };
}

describe("User API (real router, real passport, real controllers)", () => {
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
  // The guard itself. The old fixture had NO passport at all.
  // ------------------------------------------------------------------------
  describe("passport usersAuth", () => {
    const GUARDED = [
      ["get", "/api/user/profile"],
      ["put", "/api/user/profile"],
      ["get", "/api/user/setting"],
      ["put", "/api/user/setting"],
      ["post", "/api/user/changePassword"],
      ["get", "/api/user/notificationHistory"],
      ["post", "/api/user/sendOTP"],
      ["post", "/api/user/deactive-req"],
      ["post", "/api/user/deactive-confirm"],
      ["post", "/api/user/change-pair"],
    ];

    // The identity/security routes are not in GUARDED any more because they do
    // not exist. "404 for everyone" and "401 without a token" are different
    // facts and only one of them is true now, so it is asserted separately -
    // a route that came back as 401 here would mean the removal had been
    // partly reverted.
    const REMOVED = [
      ["get", "/api/user/2fa"],
      ["put", "/api/user/2fa"],
      ["patch", "/api/user/2fa"],
      ["get", "/api/user/loginHistory"],
      ["post", "/api/user/antiphishingcode"],
      ["put", "/api/user/kyc"],
      ["put", "/api/user/kyc/idproof"],
      ["put", "/api/user/kyc/addressproof"],
      ["post", "/api/user/kyc-webhook"],
      ["post", "/api/user/accessToken"],
      // ...and now the support desk, the CMS, the marketing surface and phone.
      ["get", "/api/user/support"],
      ["post", "/api/user/support"],
      ["get", "/api/user/getSupportCategory"],
      ["get", "/api/user/faq"],
      ["get", "/api/user/announcement"],
      ["get", "/api/user/slider"],
      ["get", "/api/user/getbranddetails"],
      ["post", "/api/user/addContactus"],
      ["post", "/api/user/newsLetter/subscribe"],
      ["get", "/api/user/cms/terms"],
      ["get", "/api/user/home-cms/banner"],
      ["get", "/api/user/cmcContent/x"],
      ["post", "/api/user/phoneChange"],
      ["put", "/api/user/phoneChange"],
      ["post", "/api/user/verifyOtp"],
    ];

    test.each(REMOVED)("%s %s no longer exists at all", async (method, path) => {
      const res = await api()[method](path).send({});
      expect(res.status).toBe(404);
    });

    test.each(GUARDED)("%s %s is 401 without a token", async (method, path) => {
      const res = await api()[method](path).send({});
      expect(res.status).toBe(401);
    });

    test("a session whose tokenId no longer matches is refused", async () => {
      const { user, auth } = await seedAccount();
      // A second login rotates tokenId; simulate by rewriting the stored row.
      const { redisCtrl } = getRealModules();
      const stored = await readSession(user._id);
      await redisCtrl.hset("userToken", user._id.toString(), {
        ...stored,
        tokenId: "rotated",
      });

      const res = await api().get("/api/user/profile").set("Authorization", auth);
      expect(res.status).toBe(401);
    });

    test("a session whose account is userLocked is refused", async () => {
      const { user, auth } = await seedAccount();
      const { redisCtrl } = getRealModules();
      const stored = await readSession(user._id);
      await redisCtrl.hset("userToken", user._id.toString(), {
        ...stored,
        userLocked: "true",
      });

      const res = await api().get("/api/user/profile").set("Authorization", auth);
      expect(res.status).toBe(401);
    });

    test("a session that was purged from redis is refused", async () => {
      const { user, auth } = await seedAccount();
      const { redisCtrl } = getRealModules();
      await redisCtrl.hdel("userToken", user._id.toString());

      const res = await api().get("/api/user/profile").set("Authorization", auth);
      expect(res.status).toBe(401);
    });

    test("a token whose role is not user is refused", async () => {
      const jwt = (await import("jsonwebtoken")).default;
      const { user, session } = await seedAccount();
      const { config } = getRealModules();
      const adminish = jwt.sign(
        { _id: user._id.toString(), role: "admin", tokenId: session.tokenId },
        config.secretOrKey,
        { expiresIn: "1h" }
      );
      const res = await api()
        .get("/api/user/profile")
        .set("Authorization", `Bearer ${adminish}`);
      expect(res.status).toBe(401);
    });

    test("one user's token cannot read another user's profile", async () => {
      const a = await seedAccount({ email: "a@example.com" });
      const b = await seedAccount({ email: "b@example.com" });

      const res = await api().get("/api/user/profile").set("Authorization", a.auth);
      expect(res.status).toBe(200);
      expect(res.body.result.email).toBe("a@example.com");
      expect(res.body.result._id).not.toBe(b.user._id.toString());
    });
  });

  // ------------------------------------------------------------------------
  // Profile
  // ------------------------------------------------------------------------
  describe("profile", () => {
    test("GET /profile returns the real document, and never the password material", async () => {
      const { user, auth } = await seedAccount();
      const res = await api().get("/api/user/profile").set("Authorization", auth);
      expect(res.status).toBe(200);
      expect(res.body.result.email).toBe(user.email);
      expect(res.body.result.userId).toBe(user.userId);
      // twoFAStatus / idProof / antiphishingStatus / loginHistory are no
      // longer in this payload: the UI used them to render claims about the
      // account that the product can no longer make.
      expect(res.body.result.twoFAStatus).toBeUndefined();
      expect(res.body.result.idProof).toBeUndefined();
      expect(res.body.result.antiphishingStatus).toBeUndefined();
      expect(res.body.result.loginHistory).toBeUndefined();
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(user.hash);
      expect(body).not.toContain(user.salt);
    });

    test("PUT /profile validation rejects a missing first name", async () => {
      const { auth } = await seedAccount();
      const res = await api()
        .put("/api/user/profile")
        .set("Authorization", auth)
        .send({ lastName: "Only" });
      expect(res.status).toBe(400);
      expect(res.body.errors.firstName).toBe("Enter your first name");
    });

    test("PUT /profile persists to the real document", async () => {
      const { models } = getRealModules();
      const { user, auth } = await seedAccount();
      const res = await api()
        .put("/api/user/profile")
        .set("Authorization", auth)
        .send({
          firstName: "Ada",
          lastName: "Lovelace",
          address: "1 Analytical Way",
          country: "UK",
          city: "London",
          postalCode: "E1 6AN",
        });
      expect(res.status).toBe(200);

      const after = await models.User.findById(user._id);
      expect(after.firstName).toBe("Ada");
      expect(after.lastName).toBe("Lovelace");
      expect(after.country).toBe("UK");
      expect(after.postalCode).toBe("E1 6AN");
    });
  });

  // ------------------------------------------------------------------------
  // Settings
  // ------------------------------------------------------------------------
  describe("settings", () => {
    test("GET /setting 404s for an account with no UserSetting row", async () => {
      // The controller's own note: this path used to throw inside an async
      // mongoose callback and never answer at all.
      const user = await seedUser({ email: "nosetting@example.com" });
      const { authHeader } = await issueSession(user);
      const res = await api().get("/api/user/setting").set("Authorization", authHeader);
      expect(res.status).toBe(404);
      expect(res.body.message).toBe("SETTING_NOT_FOUND");
    });

    test("PUT /setting writes through to mongo", async () => {
      const { models } = getRealModules();
      const { user, auth } = await seedAccount();
      const res = await api()
        .put("/api/user/setting")
        .set("Authorization", auth)
        .send({
          theme: "light",
          currencySymbol: "EUR",
          twoFA: true,
          afterLogin: { page: "dashboard", url: "/dashboard" },
        });
      expect(res.status).toBe(200);
      expect(res.body.message).toBe("EDIT_SETTING_SUCCESS");

      const after = await models.UserSetting.findById(user._id);
      expect(after.theme).toBe("light");
      expect(after.currencySymbol).toBe("EUR");
      expect(after.twoFA).toBe(true);
    });
    // PUT /setting/updateCryptodexFee is removed: it toggled the pay-fees-in-
    // CRYPTODEX discount, which is permanently inert since the affiliate pot it
    // debited can no longer be credited.

    test("POST /change-pair updates the setting and the live session row", async () => {
      const { models } = getRealModules();
      const { user, auth } = await seedAccount();
      const res = await api()
        .post("/api/user/change-pair")
        .set("Authorization", auth)
        .send({ type: "spot-show", showSpot: true });
      expect(res.status).toBe(200);

      expect((await models.UserSetting.findById(user._id)).showSpot).toBe(true);
      const session = await readSession(user._id);
      expect(session.showSpot).toBe(true);
      // The session must still authenticate afterwards.
      expect(
        (await api().get("/api/user/profile").set("Authorization", auth)).status
      ).toBe(200);
    });
  });

  // ------------------------------------------------------------------------
  // Change password - real pbkdf2 + real email OTP
  // ------------------------------------------------------------------------
  describe("POST /changePassword", () => {
    const requestEmailOtp = async (auth, email) => {
      await api()
        .post("/api/user/sendOTP")
        .set("Authorization", auth)
        .send({ roleType: 1, requestType: "changePassword" })
        .expect(200);
      await waitForMail(email, 1);
      return lastOtpFor(email);
    };

    test("real changePwdValidate rejects a weak new password", async () => {
      const { auth } = await seedAccount();
      const res = await api()
        .post("/api/user/changePassword")
        .set("Authorization", auth)
        .send({
          oldPassword: PASSWORD,
          password: "weak",
          confirmPassword: "weak",
          otp: "123456",
        });
      expect(res.status).toBe(400);
      expect(res.body.errors.password).toMatch(/uppercase/i);
    });

    test("a wrong current password is refused by real pbkdf2", async () => {
      const { models, } = getRealModules();
      const { user, auth } = await seedAccount();
      const res = await api()
        .post("/api/user/changePassword")
        .set("Authorization", auth)
        .send({
          oldPassword: "Nope123!",
          password: "Rotated456!",
          confirmPassword: "Rotated456!",
          otp: "123456",
          type: 2,
        });
      expect(res.status).toBe(400);
      expect(res.body.errors.oldPassword).toBe("Incorrect Password");
      expect((await models.User.findById(user._id)).authenticate(PASSWORD)).toBe(true);
    });

    test("reusing the current password as the new one is refused", async () => {
      const { auth } = await seedAccount();
      const res = await api()
        .post("/api/user/changePassword")
        .set("Authorization", auth)
        .send({
          oldPassword: PASSWORD,
          password: PASSWORD,
          confirmPassword: PASSWORD,
          otp: "123456",
          type: 2,
        });
      expect(res.status).toBe(400);
      expect(res.body.errors.password).toMatch(/same/i);
    });

    test("a wrong email OTP is refused and the password is NOT changed", async () => {
      const { models } = getRealModules();
      const { user, auth } = await seedAccount();
      await requestEmailOtp(auth, user.email);

      const res = await api()
        .post("/api/user/changePassword")
        .set("Authorization", auth)
        .send({
          oldPassword: PASSWORD,
          password: "Rotated456!",
          confirmPassword: "Rotated456!",
          otp: "000000",
          type: 2,
        });
      expect(res.status).toBe(400);
      expect(res.body.error.otp).toBe("Invalid verification code");

      const after = await models.User.findById(user._id);
      expect(after.authenticate(PASSWORD)).toBe(true);
      expect(after.authenticate("Rotated456!")).toBe(false);
    });

    test("the correct OTP rotates the password and clears the code", async () => {
      const { models } = getRealModules();
      const { user, auth } = await seedAccount();
      const otp = await requestEmailOtp(auth, user.email);

      const res = await api()
        .post("/api/user/changePassword")
        .set("Authorization", auth)
        .send({
          oldPassword: PASSWORD,
          password: "Rotated456!",
          confirmPassword: "Rotated456!",
          otp,
          type: 2,
        });
      expect(res.status).toBe(200);

      const after = await models.User.findById(user._id);
      expect(after.authenticate("Rotated456!")).toBe(true);
      expect(after.authenticate(PASSWORD)).toBe(false);
      expect(after.changepassword).toBe(true);
      expect(after.emailOTP).toBe("");
      // Salt is re-derived, so the stored hash is a genuinely new value.
      expect(after.hash).not.toBe(user.hash);
    });

    test("an unknown `type` no longer refuses the change - the CODE decides", async () => {
      // This used to answer 400 "Invalid type". There is one channel left (the
      // mailed code), so `type` is ignored; what still refuses is a wrong code,
      // which is what the case below asserts. Here the code is right.
      const { models } = getRealModules();
      const { user, auth } = await seedAccount();
      const otp = await requestEmailOtp(auth, user.email);
      const res = await api()
        .post("/api/user/changePassword")
        .set("Authorization", auth)
        .send({
          oldPassword: PASSWORD,
          password: "Rotated456!",
          confirmPassword: "Rotated456!",
          otp,
          type: 9,
        });
      expect(res.status).toBe(200);
      const after = await models.User.findById(user._id);
      expect(after.authenticate("Rotated456!")).toBe(true);
    });

    test("a bogus `type` does NOT skip the code check", async () => {
      const { models } = getRealModules();
      const { user, auth } = await seedAccount();
      const res = await api()
        .post("/api/user/changePassword")
        .set("Authorization", auth)
        .send({
          oldPassword: PASSWORD,
          password: "Rotated456!",
          confirmPassword: "Rotated456!",
          otp: "123456",
          type: 9,
        });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/verification code/i);
      expect((await models.User.findById(user._id)).authenticate(PASSWORD)).toBe(true);
    });
  });

  // ------------------------------------------------------------------------
  // Account OTP endpoints
  // ------------------------------------------------------------------------
  describe("sendOTP", () => {
    test("sendOTP mails the exact code it stored, and rate-limits a repeat", async () => {
      const { models } = getRealModules();
      const { user, auth } = await seedAccount();

      const first = await api()
        .post("/api/user/sendOTP")
        .set("Authorization", auth)
        .send({ roleType: 1, requestType: "assetPassword" });
      expect(first.status).toBe(200);
      await waitForMail(user.email, 1);
      const otp = lastOtpFor(user.email);
      await waitFor(async () => {
        const u = await models.User.findById(user._id);
        return String(u.emailOTP) === otp ? u : null;
      });
      expect(String((await models.User.findById(user._id)).emailOTP)).toBe(otp);

      const second = await api()
        .post("/api/user/sendOTP")
        .set("Authorization", auth)
        .send({ roleType: 1, requestType: "assetPassword" });
      expect(second.status).toBe(400);
      expect(second.body.message).toMatch(/after 3 minutes/i);
    });

    test("a client still asking for SMS gets the code by e-mail, not an error", async () => {
      // The SMS channel is gone and `roleType` is ignored. The bind-email and
      // (phone-less) change-password screens still post `roleType: 2`; they
      // must keep working.
      const { models } = getRealModules();
      const { user, auth } = await seedAccount();

      const res = await api()
        .post("/api/user/sendOTP")
        .set("Authorization", auth)
        .send({ roleType: 2, requestType: "emailupdate" });
      expect(res.status).toBe(200);

      await waitForMail(user.email, 1);
      const otp = lastOtpFor(user.email);
      expect(otp).toMatch(/^\d{6}$/);
      await waitFor(async () => {
        const u = await models.User.findById(user._id);
        return String(u.emailOTP) === otp ? u : null;
      });
      // ...and nothing was texted, because there is nothing to text with.
      expect(boundaries().sms).toEqual([]);
    });

    test("THE PASSWORD-CHANGE ROUND TRIP: the mailed code rotates the password", async () => {
      // The reason /sendOTP survived the removal of the phone surface, end to
      // end and through the real router: request a code, read it out of the
      // rendered mail, change the password with it, and prove the new password
      // is the one that authenticates.
      const { models } = getRealModules();
      const { user, auth } = await seedAccount();

      const sent = await api()
        .post("/api/user/sendOTP")
        .set("Authorization", auth)
        .send({ roleType: 1, requestType: "ChangePass" });
      expect(sent.status).toBe(200);

      await waitForMail(user.email, 1);
      const otp = lastOtpFor(user.email);
      await waitFor(async () => {
        const u = await models.User.findById(user._id);
        return String(u.emailOTP) === otp ? u : null;
      });

      const changed = await api()
        .post("/api/user/changePassword")
        .set("Authorization", auth)
        .send({
          oldPassword: PASSWORD,
          password: "Rotated456!",
          confirmPassword: "Rotated456!",
          otp,
          type: 2,
        });
      expect(changed.status).toBe(200);

      const after = await models.User.findById(user._id);
      expect(after.authenticate("Rotated456!")).toBe(true);
      expect(after.authenticate(PASSWORD)).toBe(false);
      expect(after.emailOTP).toBe("");
    });

    /**
     * THE DEFECT: THE FOURTH FIELD OF THE CHANGE-PASSWORD DIALOG.
     * ==========================================================
     * /security -> Login Password -> Modify asks for a verification code and
     * claimed one had been sent. `changePassword` genuinely requires it - that
     * is deliberate and it stays - and /sendOTP is the only thing that issues
     * it. Under log-only delivery the mail is rendered to the process log and
     * never sent, so the field was unanswerable and the feature could not be
     * completed by anyone without shell access to the box.
     *
     * The code is unchanged: still stored on the user, still expiring in three
     * minutes, still verified. What is fixed is that the reply no longer claims
     * a send that did not happen, and hands back the code it could not deliver.
     * The route is authenticated and the code is the caller's own.
     */
    test("with delivery off, sendOTP says so and returns the code that actually works", async () => {
      const { models } = getRealModules();
      const { user, auth } = await seedAccount();

      const sent = await api()
        .post("/api/user/sendOTP")
        .set("Authorization", auth)
        .send({ roleType: 1, requestType: "ChangePass" });

      expect(sent.status).toBe(200);
      expect(sent.body.delivered).toBe(false);
      expect(sent.body.message).not.toMatch(/sent to your email/i);
      expect(sent.body.message).toMatch(/no email was sent/i);
      expect(sent.body.verificationCode).toMatch(/^\d{6}$/);

      // It is the code that was stored, and the same one the mail carried -
      // not a decorative second number.
      const mailedCode = await waitFor(() =>
        lastOtpFor(user.email) === sent.body.verificationCode
          ? sent.body.verificationCode
          : null
      );
      expect(mailedCode).toBe(sent.body.verificationCode);
      await waitFor(async () => {
        const u = await models.User.findById(user._id);
        return String(u.emailOTP) === sent.body.verificationCode ? u : null;
      });

      // And it completes the change, which is the whole point.
      const changed = await api()
        .post("/api/user/changePassword")
        .set("Authorization", auth)
        .send({
          oldPassword: PASSWORD,
          password: "FromTheReply1!",
          confirmPassword: "FromTheReply1!",
          otp: sent.body.verificationCode,
          type: 2,
        });
      expect(changed.status).toBe(200);

      const after = await models.User.findById(user._id);
      expect(after.authenticate("FromTheReply1!")).toBe(true);
      expect(after.authenticate(PASSWORD)).toBe(false);
    });

    test("the code is still REQUIRED - disclosure is not a bypass (SECURITY)", async () => {
      // The fix must not have quietly turned "we cannot deliver the code" into
      // "the code is optional". A change with no code, and one with the wrong
      // code, must both be refused and must write nothing.
      const { models } = getRealModules();
      const { user, auth } = await seedAccount();

      await api()
        .post("/api/user/sendOTP")
        .set("Authorization", auth)
        .send({ roleType: 1, requestType: "ChangePass" })
        .expect(200);

      for (const otp of [undefined, "", "000000"]) {
        const res = await api()
          .post("/api/user/changePassword")
          .set("Authorization", auth)
          .send({
            oldPassword: PASSWORD,
            password: "ShouldNotStick1!",
            confirmPassword: "ShouldNotStick1!",
            ...(otp === undefined ? {} : { otp }),
            type: 2,
          });
        expect(res.status).toBe(400);
      }

      const after = await models.User.findById(user._id);
      expect(after.authenticate(PASSWORD)).toBe(true);
      expect(after.authenticate("ShouldNotStick1!")).toBe(false);
    });

    test("the standalone verify probe is gone, not merely unauthorised", async () => {
      const { auth } = await seedAccount();
      const res = await api()
        .post("/api/user/verifyOtp")
        .set("Authorization", auth)
        .send({ type: 2, emailOTP: "123456" });
      expect(res.status).toBe(404);
    });
  });
  // The `asset password` block is removed with POST /asset-password: it set a
  // second credential that existed only to authorise withdrawals, and there
  // are no withdrawals on this venue.

  // ------------------------------------------------------------------------
  // ACCOUNT DEACTIVATION - the destructive flow, and its compensation ledger.
  // ------------------------------------------------------------------------
  describe("account deactivation", () => {
    const requestDeactivation = async (auth, email) => {
      const res = await api()
        .post("/api/user/deactive-req")
        .set("Authorization", auth)
        .send({ roleType: 1, requestType: "deactivate" });
      expect(res.status).toBe(200);
      await waitForMail(email, 1);
      return lastOtpFor(email);
    };

    test("deactive-req mails a code and records the channel it used", async () => {
      const { models } = getRealModules();
      const { user, auth } = await seedAccount();
      const otp = await requestDeactivation(auth, user.email);
      expect(otp).toMatch(/^\d{6}$/);

      await waitFor(async () => {
        const u = await models.User.findById(user._id);
        return u.deactiveOtpChannel === "email" ? u : null;
      });
      const after = await models.User.findById(user._id);
      expect(after.deactiveOtpChannel).toBe("email");
      expect(String(after.emailOTP)).toBe(otp);
      // Nothing destructive has happened yet.
      expect(after.status).toBe("verified");
      expect(grpcCalls("deactivateWallet")).toHaveLength(0);
    });

    test("deactive-req acts on the SESSION's account, not on a body-supplied email", async () => {
      const { models } = getRealModules();
      const victim = await seedAccount({ email: "victim@example.com" });
      const attacker = await seedAccount({ email: "attacker@example.com" });

      const res = await api()
        .post("/api/user/deactive-req")
        .set("Authorization", attacker.auth)
        .send({ roleType: 1, requestType: "d", email: "victim@example.com" });
      expect(res.status).toBe(200);

      await waitForMail("attacker@example.com", 1);
      const victimAfter = await models.User.findById(victim.user._id);
      expect(victimAfter.emailOTP).toBe("");
      expect(victimAfter.deactiveOtpChannel).toBe("");
      expect(boundaries().mails.map((m) => m.to)).not.toContain("victim@example.com");
    });

    test("deactive-confirm without a pending request is refused", async () => {
      const { auth } = await seedAccount();
      const res = await api()
        .post("/api/user/deactive-confirm")
        .set("Authorization", auth)
        .send({ otp: "123456" });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe("NO_PENDING_REQUEST");
      expect(grpcCalls("deactivateWallet")).toHaveLength(0);
    });

    test("deactive-confirm with a wrong code changes nothing anywhere", async () => {
      const { models } = getRealModules();
      const { user, auth } = await seedAccount();
      await requestDeactivation(auth, user.email);

      const res = await api()
        .post("/api/user/deactive-confirm")
        .set("Authorization", auth)
        .send({ otp: "000000" });
      expect(res.status).toBe(400);
      expect(res.body.error.otp).toBe("Invalid verification code");

      expect((await models.User.findById(user._id)).status).toBe("verified");
      expect(grpcCalls("deactivateWallet")).toHaveLength(0);
      expect(grpcCalls("cancelOrderForDeactiveAcc")).toHaveLength(0);
      expect(await readSession(user._id)).toBeTruthy();
    });

    test("the happy path stands everything down IN ORDER and kills the session", async () => {
      const { models } = getRealModules();
      const { user, auth } = await seedAccount();
      const otp = await requestDeactivation(auth, user.email);

      const res = await api()
        .post("/api/user/deactive-confirm")
        .set("Authorization", auth)
        .send({ otp });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("DEACTIVATED");
      expect(res.body.positionsOpen).toBe(0);

      const after = await models.User.findById(user._id);
      expect(after.status).toBe("deactivated");
      expect(after.userLocked).toBe("true");
      expect(after.deactivatedAt).toBeTruthy();
      expect(after.deactiveOtpChannel).toBe("");

      // Session purged: the token that worked a moment ago is now dead.
      expect(await readSession(user._id)).toBeNull();
      const reuse = await api().get("/api/user/profile").set("Authorization", auth);
      expect(reuse.status).toBe(401);

      // The stand-down happened BEFORE the irreversible order sweep.
      const order = boundaries().grpc.map((c) => c.method);
      expect(order.indexOf("deactivateWallet")).toBeGreaterThanOrEqual(0);
      expect(order.indexOf("deactivateWallet")).toBeLessThan(
        order.indexOf("cancelOrderForDeactiveAcc")
      );
      // The two derivative freezes and the two derivative teardowns that used
      // to bracket this sequence went with their engines. Nothing calls either
      // engine any more, which is asserted rather than assumed.
      expect(grpcCalls("deactivatePerpetual")).toHaveLength(0);
      expect(grpcCalls("deactivateInverse")).toHaveLength(0);
    });

    test("a refusing walletapi aborts with NOTHING written and no compensation needed", async () => {
      const { models } = getRealModules();
      const { user, auth } = await seedAccount();
      const otp = await requestDeactivation(auth, user.email);
      setBoundaryBehaviour("deactivateWallet", async () => ({
        status: false,
        error: "Error on Connection",
      }));

      const res = await api()
        .post("/api/user/deactive-confirm")
        .set("Authorization", auth)
        .send({ otp });
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("WALLET_NOT_DEACTIVATED");

      const after = await models.User.findById(user._id);
      expect(after.status).toBe("verified");
      expect(after.userLocked).toBe("false");
      expect(grpcCalls("deactivatePerpetual")).toHaveLength(0);
      expect(grpcCalls("cancelOrderForDeactiveAcc")).toHaveLength(0);
      // Session survives an aborted deactivation.
      expect(
        (await api().get("/api/user/profile").set("Authorization", auth)).status
      ).toBe(200);
    });

    test("an account write that fails UNDOES the wallet freeze this call applied", async () => {
      // The compensation used to be reachable by failing a DERIVATIVE freeze.
      // Both engines are gone, so the surviving late failure is the account
      // write itself - and the property is unchanged: exactly the freeze THIS
      // call applied is undone, and nothing is left half-closed.
      const { models } = getRealModules();
      const { user, auth } = await seedAccount();
      const otp = await requestDeactivation(auth, user.email);
      const original = models.User.findOneAndUpdate;
      jest.spyOn(models.User.prototype, "save").mockImplementationOnce(async () => {
        throw new Error("mongo down");
      });

      const res = await api()
        .post("/api/user/deactive-confirm")
        .set("Authorization", auth)
        .send({ otp });

      expect(res.status).toBe(503);
      expect(res.body.status).toBe("ACCOUNT_NOT_DEACTIVATED");

      const walletCalls = grpcCalls("deactivateWallet");
      expect(walletCalls).toHaveLength(2);
      expect(walletCalls[1].body.mode).toBe("unfreeze");

      expect((await models.User.findById(user._id)).status).toBe("verified");
      expect(grpcCalls("cancelOrderForDeactiveAcc")).toHaveLength(0);
      models.User.findOneAndUpdate = original;
    });

    test("orders that cannot be cancelled are reported, and the account still closes", async () => {
      const { models } = getRealModules();
      const { user, auth } = await seedAccount();
      const otp = await requestDeactivation(auth, user.email);
      setBoundaryBehaviour("cancelOrderForDeactiveAcc", async () => ({
        status: false,
      }));

      const res = await api()
        .post("/api/user/deactive-confirm")
        .set("Authorization", auth)
        .send({ otp });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("DEACTIVATED_ORDERS_PENDING");
      expect(res.body.message).toMatch(/could not be cancelled/i);
      expect((await models.User.findById(user._id)).status).toBe("deactivated");
      // The spot sweep is now the WHOLE sweep - there are no derivative books
      // left to sweep, so a failing spot sweep is reported and the account
      // still closes, which is what the status above says.
    });

    test("a second confirm on an already-deactivated account is refused", async () => {
      const { user, auth } = await seedAccount();
      const otp = await requestDeactivation(auth, user.email);
      await api()
        .post("/api/user/deactive-confirm")
        .set("Authorization", auth)
        .send({ otp })
        .expect(200);

      // The session is gone, so re-issue one the way an operator restore would.
      const { models } = getRealModules();
      const reloaded = await models.User.findById(user._id);
      const { authHeader } = await issueSession(reloaded, {
        sessionDoc: { userLocked: "false" },
      });
      const res = await api()
        .post("/api/user/deactive-confirm")
        .set("Authorization", authHeader)
        .send({ otp });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe("ALREADY_DEACTIVATED");
    });

    test("deactive-confirm with no otp at all is refused", async () => {
      const { auth } = await seedAccount();
      const res = await api()
        .post("/api/user/deactive-confirm")
        .set("Authorization", auth)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Please enter the otp");
    });
  });

  // ------------------------------------------------------------------------
  // Read-only account surfaces
  // ------------------------------------------------------------------------
  describe("history surfaces", () => {
    test("GET /notificationHistory returns only this user's rows", async () => {
      const { models } = getRealModules();
      const mine = await seedAccount({ email: "n1@example.com" });
      const other = await seedAccount({ email: "n2@example.com" });
      await models.Notification.create([
        { userId: mine.user._id, title: "mine", description: "d" },
        { userId: other.user._id, title: "theirs", description: "d" },
      ]);

      const res = await api()
        .get("/api/user/notificationHistory")
        .set("Authorization", mine.auth);
      expect(res.status).toBe(200);
      const titles = (res.body.result || []).map((r) => r.title);
      expect(titles).toContain("mine");
      expect(titles).not.toContain("theirs");
    });

    // The three referral routes (/getReferralDetails, /getReferralHisotry,
    // /getReferralRewardHistory) were removed with the affiliate programme.
    // They are now 404 for everyone, which the route-not-found test below
    // covers generically.
    test("the withdrawn referral routes are gone, not merely unauthorised", async () => {
      const { auth } = await seedAccount();
      for (const path of [
        "/api/user/getReferralDetails",
        "/api/user/getReferralHisotry",
        "/api/user/getReferralRewardHistory",
      ]) {
        const res = await api().get(path).set("Authorization", auth);
        expect(res.status).toBe(404);
      }
    });
  });

  // ------------------------------------------------------------------------
  // Public (deliberately unauthenticated) routes on the same router.
  // ------------------------------------------------------------------------
  describe("public routes", () => {
    test("GET /siteSetting answers without a token and does not leak secrets", async () => {
      await seedSiteSetting({ supportMail: "help@cryptodex.test" });
      const res = await api().get("/api/user/siteSetting");
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toMatch(/API_KEY|SECRET_KEY/i);
    });

    // GET /faq and GET /announcement used to be tested here. Both are gone -
    // along with /slider, /getbranddetails, /addContactus,
    // /newsLetter/subscribe and the three /cms reads - and their absence is
    // asserted in the REMOVED list at the top of this file. /siteSetting is the
    // one public route left on this router, because the frontend reads it on
    // every page before login and the same row brands every outbound e-mail.

    test("GET /api/health answers unauthenticated", async () => {
      const res = await api().get("/api/health");
      expect([200, 503]).toContain(res.status);
      expect(res.body).toHaveProperty("status");
    });
  });
});
