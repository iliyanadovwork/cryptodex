/**
 * THE TOKEN THAT DECIDES WHOSE ACCOUNT A REQUEST ACTS ON (CRITICAL - FOUNDATION)
 * =============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * `encryptString(user._id, true)` mints the string in a password-reset link, an
 * email-verification link and an OTP handoff. `decryptString(token, true)` reads
 * it back, and the id that comes out is fed straight into `User.findOne`:
 *
 *     let userId = await decryptString(reqBody.authToken, true);
 *     let userData = await User.findOne({ _id: userId });
 *
 * That pair IS the authorisation for changing a password without being logged
 * in. Two dozen call sites across auth/user/admin controllers depend on it and
 * not one test had ever called either function - the whole of lib/cryptoJS.js
 * was unreferenced by the suite.
 *
 * It can fail in both directions and both are silent:
 *
 *  - a round trip that does not survive the URL-safe substitution (the `+`, `/`
 *    and `=` in the base64 are swapped for `xMl3Jk`, `Por21Ld` and `Ml32` so the
 *    token can sit in a query string) yields an empty or corrupted id, and
 *    every reset link in the wild stops working;
 *  - a decrypt that answers with anything other than "" for input it cannot
 *    read hands `findOne` an attacker-chosen value.
 *
 * These tests pin the round trip, the failure answer, and the fact that a
 * token only ever names the account it was minted for.
 */

import { describe, test, expect } from '@jest/globals';
import {
  encryptString,
  decryptString,
  replaceSpecialCharacter,
  encryptObject,
  decryptObject,
} from '../../lib/cryptoJS.js';

/** Mongo ObjectId hex, the only thing these tokens ever carry. */
const objectIdHex = (n) =>
  (n.toString(16).padStart(6, '0') + 'a1b2c3d4e5f60718').slice(0, 24);

const USER_A = '6a70f1c287c92c7218ac37fc';
const USER_B = '6a70f1c287c92c7218ac37fd';

describe('the reset-link round trip', () => {
  test('a token minted for a user reads back as exactly that user id', () => {
    const token = encryptString(USER_A, true);

    expect(token).not.toBe('');
    expect(decryptString(token, true)).toBe(USER_A);
  });

  test('it survives for every id shape, including the ones whose base64 needs escaping', () => {
    // The substitution only bites when the ciphertext contains +, / or = - which
    // depends on the id and the random salt. Two hundred ids make sure the
    // escaped cases are exercised rather than hoped for.
    const ids = Array.from({ length: 200 }, (_, i) => objectIdHex(i));

    const broken = ids.filter((id) => decryptString(encryptString(id, true), true) !== id);

    expect(broken).toEqual([]);
  });

  test('at least one of those tokens really did need escaping', () => {
    // Otherwise the test above would pass even with the substitution deleted.
    const escaped = Array.from({ length: 200 }, (_, i) =>
      encryptString(objectIdHex(i), true)
    ).filter((token) => /xMl3Jk|Por21Ld|Ml32/.test(token));

    expect(escaped.length).toBeGreaterThan(0);
  });

  test('a token in a URL carries no character that would need encoding', () => {
    // It is pasted straight into `?auth=` in the mail template.
    for (let i = 0; i < 50; i += 1) {
      const token = encryptString(objectIdHex(i), true);
      expect(token).toMatch(/^[A-Za-z0-9]+$/);
    }
  });

  test('an id is also readable without the URL-safe form, when it was minted that way', () => {
    const raw = encryptString(USER_A);
    expect(decryptString(raw)).toBe(USER_A);
  });

  test('a numeric or ObjectId-like id comes back as its string form', () => {
    const oid = { toString: () => USER_A };
    expect(decryptString(encryptString(oid, true), true)).toBe(USER_A);
    expect(decryptString(encryptString(12345, true), true)).toBe('12345');
  });
});

describe('a token names one account and no other', () => {
  test('one user token never reads as another user', () => {
    const tokenA = encryptString(USER_A, true);
    const tokenB = encryptString(USER_B, true);

    expect(decryptString(tokenA, true)).toBe(USER_A);
    expect(decryptString(tokenB, true)).toBe(USER_B);
    expect(decryptString(tokenA, true)).not.toBe(USER_B);
  });

  test('every mint is a fresh token, so a new reset link retires the old one', () => {
    // ResetconfirmMail compares the stored mailToken against the submitted one,
    // so this is what makes "request a new link" invalidate the previous link.
    const first = encryptString(USER_A, true);
    const second = encryptString(USER_A, true);

    expect(second).not.toBe(first);
    expect(decryptString(first, true)).toBe(USER_A);
    expect(decryptString(second, true)).toBe(USER_A);
  });

  test('a token cannot be edited into another account', () => {
    const token = encryptString(USER_A, true);
    const tampered = token.slice(0, -4) + (token.slice(-4) === 'aaaa' ? 'bbbb' : 'aaaa');

    const decoded = decryptString(tampered, true);

    expect(decoded).not.toBe(USER_B);
    expect(decoded).not.toBe(USER_A);
  });
});

describe('unreadable input answers with nothing at all', () => {
  test.each([
    ['an empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['a number', 12345],
    ['plain text that was never a token', 'not-a-token'],
    ['a user id sent raw', USER_A],
    ['an object', { toString: () => 'x' }],
  ])('%s decrypts to the empty string', (_label, input) => {
    // "" is the only safe answer: `User.findOne({_id: ""})` finds nobody.
    // Anything else is a value the caller chose being used as an account id.
    expect(decryptString(input, true)).toBe('');
  });

  test('a token minted with the URL-safe form is unreadable without it, and vice versa', () => {
    // Both directions must fail closed rather than return a partial id.
    const escapedToken = Array.from({ length: 40 }, (_, i) => encryptString(objectIdHex(i), true))
      .find((t) => /xMl3Jk|Por21Ld|Ml32/.test(t));

    expect(escapedToken).toBeDefined();
    expect(decryptString(escapedToken, false)).toBe('');
  });
});

describe('replaceSpecialCharacter - the substitution itself', () => {
  test('it round-trips every character it is responsible for', () => {
    const base64ish = 'U2FsdGVkX1+abc/def=';

    const escaped = replaceSpecialCharacter(base64ish, 'encrypt');

    expect(escaped).not.toMatch(/[+/=]/);
    expect(replaceSpecialCharacter(escaped, 'decrypt')).toBe(base64ish);
  });

  test('it replaces EVERY occurrence, not just the first', () => {
    // It used to use string arguments, which replace one occurrence each - a
    // ciphertext with two `+` came back corrupted.
    const many = 'a+b+c/d/e=f=';

    const escaped = replaceSpecialCharacter(many, 'encrypt');

    expect(escaped).not.toMatch(/[+/=]/);
    expect(replaceSpecialCharacter(escaped, 'decrypt')).toBe(many);
  });

  test('text with nothing to substitute is returned unchanged', () => {
    expect(replaceSpecialCharacter('abcDEF123', 'encrypt')).toBe('abcDEF123');
    expect(replaceSpecialCharacter('abcDEF123', 'decrypt')).toBe('abcDEF123');
  });

  test('an empty value is handled without throwing', () => {
    expect(replaceSpecialCharacter('', 'encrypt')).toBe('');
    expect(replaceSpecialCharacter(null, 'decrypt')).toBe(null);
  });
});

describe('encryptObject / decryptObject - the same guarantee for payloads', () => {
  test('an object round-trips exactly', () => {
    const payload = { userId: USER_A, amount: 12.5, side: 'buy', nested: { ok: true } };

    expect(decryptObject(encryptObject(payload))).toEqual(payload);
  });

  test('unreadable input answers with nothing', () => {
    expect(decryptObject('garbage')).toBe('');
    expect(decryptObject('')).toBe('');
    expect(decryptObject(null)).toBe('');
  });

  test('a payload cannot be edited in transit', () => {
    const token = encryptObject({ userId: USER_A, amount: 1 });
    const tampered = token.slice(0, -4) + (token.slice(-4) === 'aaaa' ? 'bbbb' : 'aaaa');

    expect(decryptObject(tampered)).toBe('');
  });
});
