/**
 * PASSWORD RESET - AGAINST THE SHIPPED VALIDATORS AND THE SHIPPED TOKENS
 * =====================================================================
 *
 * WHAT THIS FILE USED TO BE
 * -------------------------
 * It imported nothing from the service. It declared its own
 * `const passwordRegex = /.../`, its own `generateResetToken`, its own
 * `isTokenExpired`, and then asserted that its own regex rejected "weak" and
 * that its own token generator produced 64 hex characters. The service's real
 * reset token is a CryptoJS AES ciphertext of the user's ObjectId with `+/=`
 * substituted for URL safety (lib/cryptoJS.encryptString(value, true)) - not
 * hex, not random, and reversible. Nothing in the old file could have noticed.
 *
 * WHAT IT IS NOW
 * --------------
 * The real `resetPwdValidate` / `checkForgotPwdValidate` / `confirmMailValidate`
 * / `activateRegsiterUser` middlewares and the real
 * `encryptString` / `decryptString` / `replaceSpecialCharacter` from
 * lib/cryptoJS.js, which is what actually mints and reads every reset and
 * activation link this service sends.
 */

import { describe, test, expect } from "@jest/globals";
import mongoose from "mongoose";

import {
  resetPwdValidate,
  checkForgotPwdValidate,
  confirmMailValidate,
  activateRegsiterUser,
} from "../../validation/user.validation.js";
import {
  encryptString,
  decryptString,
  replaceSpecialCharacter,
} from "../../lib/cryptoJS.js";

/** Drive a real express middleware and report what it did. */
const runMiddleware = (mw, body) => {
  const res = {
    statusCode: null,
    payload: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.payload = p; return this; },
  };
  let nexted = false;
  mw({ body }, res, () => { nexted = true; });
  return { nexted, status: res.statusCode, payload: res.payload };
};

const errorsOf = (r) => (r.payload && r.payload.errors) || {};

describe("checkForgotPwdValidate (the entry point of a reset)", () => {
  test("accepts a well-formed email request", () => {
    const r = runMiddleware(checkForgotPwdValidate, {
      roleType: 1,
      email: "user@example.com",
    });
    expect(r.nexted).toBe(true);
  });

  test("requires an email and rejects a malformed one", () => {
    expect(errorsOf(runMiddleware(checkForgotPwdValidate, { roleType: 1 })).email).toBe(
      "Please enter your email"
    );
    expect(
      errorsOf(
        runMiddleware(checkForgotPwdValidate, { roleType: 1, email: "not-an-email" })
      ).email
    ).toBe("Please enter valid email address");
    expect(
      errorsOf(
        runMiddleware(checkForgotPwdValidate, { roleType: 1, email: "a@b" })
      ).email
    ).toBe("Please enter valid email address");
  });

  test("does not demand a reCAPTCHA token under NODE_ENV=test", () => {
    // lib/recaptcha.recaptchaVerificationRequired() is the single source of
    // truth for this, and production is NOT waived - see recaptcha-presence
    // guard tests for that half.
    expect(process.env.NODE_ENV).toBe("test");
    const r = runMiddleware(checkForgotPwdValidate, {
      roleType: 1,
      email: "user@example.com",
    });
    expect(r.nexted).toBe(true);
    expect(errorsOf(r).reCaptcha).toBeUndefined();
  });
});

describe("resetPwdValidate (the last gate before a password is written)", () => {
  const ok = {
    authToken: "tok",
    password: "Rotated456!",
    confirmPassword: "Rotated456!",
  };

  test("accepts a complete, strong submission", () => {
    expect(runMiddleware(resetPwdValidate, ok).nexted).toBe(true);
  });

  test("refuses a submission with no token at all", () => {
    const r = runMiddleware(resetPwdValidate, { ...ok, authToken: "" });
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(400);
    expect(errorsOf(r).authToken).toBe("AuthToken field is required");
  });

  test("enforces the shipped strength rule, not a paraphrase of it", () => {
    const reject = (pw) =>
      errorsOf(runMiddleware(resetPwdValidate, { ...ok, password: pw, confirmPassword: pw }))
        .password;

    expect(reject("alllowercase1!")).toBeTruthy(); // no uppercase
    expect(reject("ALLUPPERCASE1!")).toBeTruthy(); // no lowercase
    expect(reject("NoDigitsHere!")).toBeTruthy(); // no digit
    expect(reject("NoSpecial123")).toBeTruthy(); // no special char
    expect(reject("Ab1!x")).toBeTruthy(); // under 6
    expect(reject("Abcdefghij12345678!")).toBeTruthy(); // over 18
    expect(reject("Abc12!")).toBeUndefined(); // exactly 6, all classes
  });

  test("refuses a mismatched confirmation", () => {
    const r = runMiddleware(resetPwdValidate, { ...ok, confirmPassword: "Other456!" });
    expect(errorsOf(r).confirmPassword).toBe("Passwords must match");
  });

  test("requires the confirmation field to be present", () => {
    const r = runMiddleware(resetPwdValidate, { ...ok, confirmPassword: "" });
    expect(errorsOf(r).confirmPassword).toBe("Confirm password field is required");
  });

  test("reports every problem at once so the form can show them all", () => {
    const r = runMiddleware(resetPwdValidate, {});
    expect(Object.keys(errorsOf(r)).sort()).toEqual([
      "authToken",
      "confirmPassword",
      "password",
    ]);
  });
});

describe("confirmMailValidate / activateRegsiterUser", () => {
  test("each requires its own token field name", () => {
    // These two guard different endpoints and read DIFFERENT body keys
    // (`authToken` vs `userId`). A single shared "token" assumption - which is
    // what the old file tested - would have missed that.
    expect(runMiddleware(confirmMailValidate, { authToken: "x" }).nexted).toBe(true);
    expect(errorsOf(runMiddleware(confirmMailValidate, { userId: "x" })).authToken).toBe(
      "AuthToken field is required"
    );

    expect(runMiddleware(activateRegsiterUser, { userId: "x" }).nexted).toBe(true);
    expect(errorsOf(runMiddleware(activateRegsiterUser, { authToken: "x" })).userId).toBe(
      "AuthToken field is required"
    );
  });
});

describe("lib/cryptoJS.js - the actual reset / activation token", () => {
  const id = () => new mongoose.Types.ObjectId().toString();

  test("a token round-trips back to the account id it was minted for", () => {
    const userId = id();
    const token = encryptString(userId, true);
    expect(token).toBeTruthy();
    expect(token).not.toContain(userId);
    expect(decryptString(token, true)).toBe(userId);
  });

  test("the URL-safe form contains no characters that break a query string", () => {
    for (let i = 0; i < 40; i++) {
      const token = encryptString(id(), true);
      expect(token).not.toMatch(/[+/=]/);
    }
  });

  test("the substitution is exactly the shipped one, and reverses", () => {
    const raw = "a+b/c=";
    const encoded = replaceSpecialCharacter(raw, "encrypt");
    expect(encoded).toBe("axMl3JkbPor21LdcMl32");
    expect(replaceSpecialCharacter(encoded, "decrypt")).toBe(raw);
  });

  test("two tokens for the same account are different ciphertexts that both decrypt", () => {
    // CryptoJS AES uses a random salt per call, so the emailed link is not a
    // stable identifier that can be recognised across sends.
    const userId = id();
    const a = encryptString(userId, true);
    const b = encryptString(userId, true);
    expect(a).not.toBe(b);
    expect(decryptString(a, true)).toBe(userId);
    expect(decryptString(b, true)).toBe(userId);
  });

  test("a tampered token never resolves to the account it was minted for", () => {
    // 200 independent tokens, each with its tail rewritten. The important
    // property is that flipping ciphertext can never yield a DIFFERENT valid
    // account id either - decryptString must not become an account oracle.
    for (let i = 0; i < 200; i++) {
      const userId = id();
      const token = encryptString(userId, true);
      const flipped =
        token.slice(0, -4) + (token.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
      const out = decryptString(flipped, true);
      expect(out).not.toBe(userId);
      expect(out).not.toMatch(/^[0-9a-f]{24}$/);
    }
  });

  test("garbage in gives '' out instead of throwing", () => {
    // The controllers call decryptString and then query mongo with the result;
    // a throw here would surface as a 500 on a bad link.
    expect(decryptString("clearly-not-a-token", true)).toBe("");
    expect(decryptString("", true)).toBe("");
    expect(decryptString(undefined, true)).toBe("");
    expect(encryptString(undefined, true)).toBe("");
  });

  test("the plain (non URL-safe) form also round-trips, and is the one that carries +/=", () => {
    const userId = id();
    const plain = encryptString(userId, false);
    expect(decryptString(plain, false)).toBe(userId);
    // The plain form is what the substitution exists to make link-safe.
    expect(replaceSpecialCharacter(plain, "encrypt")).not.toMatch(/[+/=]/);
  });

  test("replaceSpecialCharacter leaves an empty value alone", () => {
    expect(replaceSpecialCharacter("", "encrypt")).toBe("");
    expect(replaceSpecialCharacter(undefined, "decrypt")).toBeUndefined();
  });
});
