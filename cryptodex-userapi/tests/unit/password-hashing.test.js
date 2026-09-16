/**
 * PASSWORD HASHING - AGAINST THE SHIPPED CODE
 * ===========================================
 *
 * WHAT THIS FILE USED TO BE
 * -------------------------
 * It imported nothing from the service. It declared, inside the test file:
 *
 *     const makeSalt = () => crypto.randomBytes(16).toString('base64');
 *     const encryptPassword = (password, salt) => {
 *       if (!password || !salt) return '';
 *       return crypto.pbkdf2Sync(password, Buffer.from(salt,'base64'),
 *                                100000, 128, 'sha512').toString('base64');
 *     };
 *
 * ...and then asserted that THAT function was deterministic, salt-sensitive and
 * returned '' for an empty password. Every one of those 45 assertions was about
 * a copy living in the test file. models/User.js could have been deleted, or
 * had its iteration count dropped to 1, and the file stayed green.
 *
 * WHAT IT IS NOW
 * --------------
 * `User.prototype.makeSalt` / `encryptPassword` / `authenticate` and the
 * `password` virtual, imported from models/User.js, plus lib/bcrypt.js, which
 * is what the ADMIN side hashes with. No hashing is reimplemented here; where a
 * parameter has to be pinned (100000 iterations, sha512, 128 bytes) the test
 * recomputes with node crypto and compares against the model's output, so a
 * change to the shipped parameters is a failure rather than a silent weakening.
 */

import { describe, test, expect } from "@jest/globals";
import crypto from "crypto";

import { User } from "../../models/index.js";
import { generatePassword, comparePassword } from "../../lib/bcrypt.js";

const newUser = () => new User();

describe("User model salt (models/User.js makeSalt)", () => {
  test("is 16 random bytes, base64", () => {
    const salt = newUser().makeSalt();
    expect(typeof salt).toBe("string");
    expect(salt).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(Buffer.from(salt, "base64")).toHaveLength(16);
  });

  test("is different every time", () => {
    const u = newUser();
    const salts = new Set(Array.from({ length: 50 }, () => u.makeSalt()));
    expect(salts.size).toBe(50);
  });
});

describe("User model password encryption (models/User.js encryptPassword)", () => {
  test("uses pbkdf2-sha512 with 100000 iterations and a 128-byte key", () => {
    // Recomputed independently: if anyone lowers the work factor, changes the
    // digest or shortens the key, this line stops matching.
    const u = newUser();
    u.salt = u.makeSalt();
    const expected = crypto
      .pbkdf2Sync("SmokeTest123!", Buffer.from(u.salt, "base64"), 100000, 128, "sha512")
      .toString("base64");
    expect(u.encryptPassword("SmokeTest123!")).toBe(expected);
    expect(Buffer.from(expected, "base64")).toHaveLength(128);
  });

  test("is deterministic for one salt and salt-sensitive across salts", () => {
    const a = newUser();
    a.salt = a.makeSalt();
    const b = newUser();
    b.salt = b.makeSalt();

    expect(a.encryptPassword("pw")).toBe(a.encryptPassword("pw"));
    expect(a.encryptPassword("pw")).not.toBe(b.encryptPassword("pw"));
    expect(a.encryptPassword("pw")).not.toBe(a.encryptPassword("pw2"));
  });

  test("returns '' rather than a hash when there is nothing to hash", () => {
    const u = newUser();
    u.salt = u.makeSalt();
    expect(u.encryptPassword("")).toBe("");
    expect(u.encryptPassword(undefined)).toBe("");

    const noSalt = newUser();
    expect(noSalt.salt).toBeUndefined();
    expect(noSalt.encryptPassword("pw")).toBe("");
  });

  test("a one-character difference changes the whole digest", () => {
    const u = newUser();
    u.salt = u.makeSalt();
    const a = Buffer.from(u.encryptPassword("SmokeTest123!"), "base64");
    const b = Buffer.from(u.encryptPassword("SmokeTest123?"), "base64");
    let same = 0;
    for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
    // Two independent 128-byte digests agree on ~0.4 bytes on average.
    expect(same).toBeLessThan(10);
  });
});

describe("the `password` virtual and authenticate()", () => {
  test("assigning `password` derives a fresh salt and hash and keeps no plaintext field", () => {
    const u = newUser();
    u.password = "SmokeTest123!";

    expect(u.salt).toBeTruthy();
    expect(u.hash).toBeTruthy();
    expect(u.hash).not.toContain("SmokeTest123!");
    // The virtual is not a schema path, so nothing plaintext is PERSISTED.
    expect(User.schema.path("password")).toBeUndefined();
    expect(u.toObject({ virtuals: false }).password).toBeUndefined();
  });

  /**
   * DEFECT, DOCUMENTED NOT FIXED - reported separately.
   *
   * models/User.js sets `toObject: { virtuals: true }` and
   * `toJSON: { virtuals: true }`, and `password` is a virtual with a getter
   * that returns `this._password`. So for the lifetime of a document that has
   * just had a new password assigned, serialising it - `res.json(userDoc)`,
   * `console.log(userDoc)`, spreading it into a response - emits the
   * PLAINTEXT password. Nothing on the live request paths does that today,
   * which is the only reason it is not an active leak; it is one
   * `res.json({ result: userData })` away from being one.
   */
  test("the `password` virtual IS serialised by toJSON while it is set in memory", () => {
    const u = newUser();
    u.password = "SmokeTest123!";
    expect(u.toJSON().password).toBe("SmokeTest123!");

    // A document that was loaded rather than assigned carries nothing.
    const loaded = newUser();
    loaded.hash = u.hash;
    loaded.salt = u.salt;
    expect(loaded.toJSON().password).toBeUndefined();
  });

  test("authenticate() accepts the assigned password and nothing else", () => {
    const u = newUser();
    u.password = "SmokeTest123!";

    expect(u.authenticate("SmokeTest123!")).toBe(true);
    expect(u.authenticate("smoketest123!")).toBe(false);
    expect(u.authenticate("SmokeTest123")).toBe(false);
    expect(u.authenticate("")).toBe(false);
    expect(u.authenticate(undefined)).toBe(false);
    expect(u.authenticate(u.hash)).toBe(false);
  });

  test("re-assigning the same password produces a different stored hash", () => {
    const u = newUser();
    u.password = "SmokeTest123!";
    const firstHash = u.hash;
    const firstSalt = u.salt;

    u.password = "SmokeTest123!";
    expect(u.salt).not.toBe(firstSalt);
    expect(u.hash).not.toBe(firstHash);
    expect(u.authenticate("SmokeTest123!")).toBe(true);
  });

  test("two accounts with the same password do not share a hash", () => {
    const a = newUser();
    const b = newUser();
    a.password = "SmokeTest123!";
    b.password = "SmokeTest123!";
    expect(a.hash).not.toBe(b.hash);
  });

  test("a rotated password stops accepting the old one", () => {
    const u = newUser();
    u.password = "SmokeTest123!";
    u.password = "Rotated456!";
    expect(u.authenticate("Rotated456!")).toBe(true);
    expect(u.authenticate("SmokeTest123!")).toBe(false);
  });

  test("a document whose salt was tampered with authenticates nothing", () => {
    const u = newUser();
    u.password = "SmokeTest123!";
    u.salt = newUser().makeSalt();
    expect(u.authenticate("SmokeTest123!")).toBe(false);
  });
});

describe("lib/bcrypt.js (the admin-side hasher)", () => {
  test("generatePassword returns a bcrypt hash and reports success", () => {
    const res = generatePassword("SmokeTest123!");
    expect(res.passwordStatus).toBe(true);
    expect(res.hash).toMatch(/^\$2[aby]\$\d{2}\$/);
    expect(res.hash).not.toContain("SmokeTest123!");
  });

  test("the cost factor is 10", () => {
    const { hash } = generatePassword("SmokeTest123!");
    expect(hash.split("$")[2]).toBe("10");
  });

  test("two hashes of the same password differ, and both verify", () => {
    const a = generatePassword("SmokeTest123!");
    const b = generatePassword("SmokeTest123!");
    expect(a.hash).not.toBe(b.hash);
    expect(comparePassword("SmokeTest123!", a.hash).passwordStatus).toBe(true);
    expect(comparePassword("SmokeTest123!", b.hash).passwordStatus).toBe(true);
  });

  test("comparePassword refuses a wrong password", () => {
    const { hash } = generatePassword("SmokeTest123!");
    expect(comparePassword("wrong", hash).passwordStatus).toBe(false);
    expect(comparePassword("", hash).passwordStatus).toBe(false);
  });

  test("comparePassword answers false rather than throwing on a malformed hash", () => {
    // Every caller reads `.passwordStatus`; a throw here would surface as a 500
    // on a login form instead of "wrong password".
    expect(comparePassword("SmokeTest123!", "not-a-hash").passwordStatus).toBe(false);
    expect(comparePassword("SmokeTest123!", undefined).passwordStatus).toBe(false);
    expect(comparePassword(undefined, undefined).passwordStatus).toBe(false);
  });

  test("generatePassword answers a failure object rather than throwing", () => {
    // bcryptjs/bcrypt reject a non-string; the wrapper must not let that escape.
    const res = generatePassword(undefined);
    expect(res.passwordStatus).toBe(false);
    expect(res.hash).toBeUndefined();
  });

  test("the two hashers are NOT interchangeable", () => {
    // User accounts are pbkdf2, admin accounts are bcrypt. Mixing them silently
    // would mean a password that verifies nowhere.
    const u = newUser();
    u.password = "SmokeTest123!";
    expect(comparePassword("SmokeTest123!", u.hash).passwordStatus).toBe(false);
    const { hash } = generatePassword("SmokeTest123!");
    expect(u.authenticate(hash)).toBe(false);
  });
});
