/**
 * WHETHER A reCAPTCHA TOKEN MUST BE PRESENT (CRITICAL - REGRESSION)
 * ================================================================
 *
 * WHAT WAS WRONG
 * --------------
 * `registerValidate` and `checkForgotPwdValidate` unconditionally rejected any
 * request without `reCaptcha`. The client can only supply that token when
 * GoogleReCaptchaProvider actually mounts, which it does not on a host whose
 * site key cannot serve it - a plain localhost dev box. So on this deployment
 * EVERY registration and EVERY password reset came back
 * 400 {"errors":{"reCaptcha":"ReCAPTCHA field is required"}} and the product
 * had no front door at all.
 *
 * `recaptchaRequired()` is the fix: the PRESENCE check is waived on an explicit
 * non-production signal, and only then.
 *
 * WHY THESE TESTS EXIST
 * ---------------------
 * A verifier replaced the whole of `recaptchaRequired()` with `return true` -
 * restoring the exact bug that bricked signup for every new user - and all 538
 * tests stayed green. Nothing in the suite ever asked what the guard answers.
 * It is four lines of environment logic sitting under the two doors into the
 * product, and it is capable of failing in both directions:
 *
 *   - too strict, and nobody can register here (the original bug);
 *   - too lax, and production stops demanding the token, which is the only
 *     reason the token is ever collected.
 *
 * `recaptchaRequired` is deliberately not exported, so these tests go through
 * the two middlewares that use it - which is also the only way to prove the
 * waiver waives the reCAPTCHA field ALONE and nothing else on the form.
 */

import { describe, test, expect, beforeEach, afterAll } from '@jest/globals';
import {
  registerValidate,
  checkForgotPwdValidate,
} from '../../validation/user.validation.js';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const ENV_KEYS = ['NODE_ENV', 'TEST_MODE', 'DEV_RECAPTCHA_BYPASS'];
const ORIGINAL_ENV = {};
for (const key of ENV_KEYS) ORIGINAL_ENV[key] = process.env[key];

const setEnv = (values) => {
  for (const key of ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(values, key) && values[key] !== undefined) {
      process.env[key] = values[key];
    } else {
      delete process.env[key];
    }
  }
};

const restoreEnv = () => {
  for (const key of ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
};

beforeEach(() => restoreEnv());
afterAll(() => restoreEnv());

/**
 * Runs a validator and reports what the caller would actually receive:
 * whether it was let through, and the error body if it was not.
 */
const run = (validator, body) => {
  const outcome = { passed: false, statusCode: null, errors: null };
  const res = {
    status(code) {
      outcome.statusCode = code;
      return this;
    },
    json(payload) {
      outcome.errors = payload.errors;
      return this;
    },
  };
  validator({ body }, res, () => {
    outcome.passed = true;
  });
  return outcome;
};

/** A registration form that is valid in every respect EXCEPT the token. */
const signup = (extra = {}) => ({
  roleType: 1,
  email: 'papersmoke1@test.com',
  password: 'SmokeTest123!',
  confirmPassword: 'SmokeTest123!',
  ...extra,
});

const forgot = (extra = {}) => ({
  roleType: 1,
  email: 'papersmoke1@test.com',
  ...extra,
});

const phoneSignup = (extra = {}) => ({
  roleType: 2,
  newPhoneNo: '5551234567',
  newPhoneCode: '+1',
  password: 'SmokeTest123!',
  confirmPassword: 'SmokeTest123!',
  ...extra,
});

// ---------------------------------------------------------------------------
// Production always demands the token.
// ---------------------------------------------------------------------------

describe('production requires the token', () => {
  test('registration without one is rejected', () => {
    setEnv({ NODE_ENV: 'production' });

    const outcome = run(registerValidate, signup());

    expect(outcome.passed).toBe(false);
    expect(outcome.statusCode).toBe(400);
    expect(outcome.errors).toEqual({ reCaptcha: 'ReCAPTCHA field is required' });
  });

  test('registration with one is let through', () => {
    setEnv({ NODE_ENV: 'production' });

    const outcome = run(registerValidate, signup({ reCaptcha: '03AGdBq26...' }));

    expect(outcome.passed).toBe(true);
    expect(outcome.statusCode).toBe(null);
  });

  test('a blank token is not a token', () => {
    setEnv({ NODE_ENV: 'production' });

    expect(run(registerValidate, signup({ reCaptcha: '   ' })).errors).toEqual({
      reCaptcha: 'ReCAPTCHA field is required',
    });
    expect(run(registerValidate, signup({ reCaptcha: '' })).errors).toEqual({
      reCaptcha: 'ReCAPTCHA field is required',
    });
    expect(run(registerValidate, signup({ reCaptcha: null })).errors).toEqual({
      reCaptcha: 'ReCAPTCHA field is required',
    });
  });

  test('password reset without one is rejected', () => {
    setEnv({ NODE_ENV: 'production' });

    const outcome = run(checkForgotPwdValidate, forgot());

    expect(outcome.passed).toBe(false);
    expect(outcome.statusCode).toBe(400);
    expect(outcome.errors).toEqual({ reCaptcha: 'ReCAPTCHA field is required' });
  });

  test('password reset with one is let through', () => {
    setEnv({ NODE_ENV: 'production' });

    expect(run(checkForgotPwdValidate, forgot({ reCaptcha: 'token' })).passed).toBe(true);
  });

  test('phone registration without one is rejected', () => {
    setEnv({ NODE_ENV: 'production' });

    const outcome = run(registerValidate, phoneSignup());

    expect(outcome.passed).toBe(false);
    expect(outcome.errors).toEqual({ reCaptcha: 'ReCAPTCHA field is required' });
  });
});

// ---------------------------------------------------------------------------
// An explicit non-production signal waives the PRESENCE check.
// ---------------------------------------------------------------------------

describe('an explicit non-production signal waives the presence check', () => {
  test.each([
    ['NODE_ENV=development', { NODE_ENV: 'development' }],
    ['NODE_ENV=test', { NODE_ENV: 'test' }],
    ['TEST_MODE=true', { NODE_ENV: 'staging', TEST_MODE: 'true' }],
    ['DEV_RECAPTCHA_BYPASS=true', { NODE_ENV: 'staging', DEV_RECAPTCHA_BYPASS: 'true' }],
  ])('%s lets a tokenless registration through', (_label, env) => {
    setEnv(env);

    const outcome = run(registerValidate, signup());

    expect(outcome.passed).toBe(true);
    expect(outcome.statusCode).toBe(null);
    expect(outcome.errors).toBe(null);
  });

  test.each([
    ['NODE_ENV=development', { NODE_ENV: 'development' }],
    ['NODE_ENV=test', { NODE_ENV: 'test' }],
    ['TEST_MODE=true', { NODE_ENV: 'staging', TEST_MODE: 'true' }],
    ['DEV_RECAPTCHA_BYPASS=true', { NODE_ENV: 'staging', DEV_RECAPTCHA_BYPASS: 'true' }],
  ])('%s lets a tokenless password reset through', (_label, env) => {
    setEnv(env);

    const outcome = run(checkForgotPwdValidate, forgot());

    expect(outcome.passed).toBe(true);
    expect(outcome.errors).toBe(null);
  });

  test('a tokenless phone registration is let through too', () => {
    setEnv({ NODE_ENV: 'development' });

    expect(run(registerValidate, phoneSignup()).passed).toBe(true);
  });

  test('a token supplied anyway is still accepted', () => {
    setEnv({ NODE_ENV: 'development' });

    expect(run(registerValidate, signup({ reCaptcha: 'token' })).passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The waiver never reaches production.
// ---------------------------------------------------------------------------

describe('the waiver never applies in production', () => {
  test.each([
    ['TEST_MODE=true', { NODE_ENV: 'production', TEST_MODE: 'true' }],
    ['DEV_RECAPTCHA_BYPASS=true', { NODE_ENV: 'production', DEV_RECAPTCHA_BYPASS: 'true' }],
    [
      'both bypass flags at once',
      { NODE_ENV: 'production', TEST_MODE: 'true', DEV_RECAPTCHA_BYPASS: 'true' },
    ],
  ])('%s does not disarm registration', (_label, env) => {
    setEnv(env);

    const outcome = run(registerValidate, signup());

    expect(outcome.passed).toBe(false);
    expect(outcome.errors).toEqual({ reCaptcha: 'ReCAPTCHA field is required' });
  });

  test('nor does it disarm password reset', () => {
    setEnv({ NODE_ENV: 'production', TEST_MODE: 'true' });

    expect(run(checkForgotPwdValidate, forgot()).passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Silence is not a waiver: only the listed signals opt out.
// ---------------------------------------------------------------------------

describe('an unrecognised or absent environment still requires the token', () => {
  test.each([
    ['a deploy that forgot NODE_ENV', {}],
    ['NODE_ENV=staging', { NODE_ENV: 'staging' }],
    ['NODE_ENV=prod (not the exact word)', { NODE_ENV: 'prod' }],
    ['NODE_ENV=Production (wrong case)', { NODE_ENV: 'Production' }],
    ['TEST_MODE=1 rather than the string true', { NODE_ENV: 'staging', TEST_MODE: '1' }],
    ['TEST_MODE=false', { NODE_ENV: 'staging', TEST_MODE: 'false' }],
    [
      'DEV_RECAPTCHA_BYPASS=yes rather than true',
      { NODE_ENV: 'staging', DEV_RECAPTCHA_BYPASS: 'yes' },
    ],
  ])('%s', (_label, env) => {
    setEnv(env);

    const outcome = run(registerValidate, signup());

    expect(outcome.passed).toBe(false);
    expect(outcome.errors).toEqual({ reCaptcha: 'ReCAPTCHA field is required' });
  });
});

// ---------------------------------------------------------------------------
// The waiver waives the reCAPTCHA field and nothing else.
// ---------------------------------------------------------------------------

describe('the waiver is confined to the reCAPTCHA field', () => {
  test('the rest of the registration form is still validated', () => {
    setEnv({ NODE_ENV: 'development' });

    const outcome = run(
      registerValidate,
      signup({ email: 'not-an-email', password: 'weak', confirmPassword: 'weak' })
    );

    expect(outcome.passed).toBe(false);
    expect(outcome.statusCode).toBe(400);
    expect(outcome.errors.email).toBe('Email is invalid');
    expect(outcome.errors.password).toBeDefined();
    expect(outcome.errors.reCaptcha).toBeUndefined();
  });

  test('mismatched passwords are still caught', () => {
    setEnv({ NODE_ENV: 'development' });

    const outcome = run(registerValidate, signup({ confirmPassword: 'SomethingElse1!' }));

    expect(outcome.passed).toBe(false);
    expect(outcome.errors).toEqual({ confirmPassword: 'Passwords must match' });
  });

  test('a password reset still needs a valid email', () => {
    setEnv({ NODE_ENV: 'development' });

    const outcome = run(checkForgotPwdValidate, forgot({ email: 'nope' }));

    expect(outcome.passed).toBe(false);
    expect(outcome.errors).toEqual({ email: 'Please enter valid email address' });
  });

  test('in production a bad form reports its other faults alongside the missing token', () => {
    setEnv({ NODE_ENV: 'production' });

    const outcome = run(registerValidate, signup({ email: '' }));

    expect(outcome.errors.email).toBe('Email field is required');
    expect(outcome.errors.reCaptcha).toBe('ReCAPTCHA field is required');
  });
});

// ---------------------------------------------------------------------------
// The original bug, stated as a test.
// ---------------------------------------------------------------------------

describe('the localhost signup regression', () => {
  test('a dev box with no reCAPTCHA provider can still register and reset', () => {
    // This is the whole point: the frontend cannot mount
    // GoogleReCaptchaProvider here, so no request will ever carry a token.
    setEnv({ NODE_ENV: 'development' });

    expect(run(registerValidate, signup()).passed).toBe(true);
    expect(run(checkForgotPwdValidate, forgot()).passed).toBe(true);
  });
});
