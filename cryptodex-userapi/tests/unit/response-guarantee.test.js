/**
 * Response Guarantee Regression Tests (SECURITY / AVAILABILITY)
 *
 * Several handlers in this service used to `catch` an error, log it, and fall
 * off the end of the function without ever calling `res.*`. Express cannot
 * detect that: the socket stays open until the client gives up. On an
 * unauthenticated route that is a free connection-exhaustion primitive.
 *
 * The confirmed instance was GET /api/admin/getAdminBal, which referenced a
 * `Currency` model that does not exist in userapi -- every call threw a
 * ReferenceError into an empty catch and hung forever, unauthenticated.
 *
 * These tests cover:
 *   1. the `responseGuard` backstop middleware, and
 *   2. the specific repaired handlers that can be imported without dragging in
 *      the gRPC modules (which use `import.meta` and cannot be babel-transformed).
 *
 * The blocks that covered admin.controller.js (getAdminBal, getUserData,
 * CheckAuthToken) and common.controller.js (SendNewsletter, the unauthenticated
 * mass-mail route) are GONE, because those two files are gone: the admin panel
 * and the newsletter/contact/slider surface were removed from this service. A
 * handler that no longer exists cannot hang. What remains here is the guard
 * middleware itself plus the surviving handlers of the same shape.
 */

import { describe, test, expect, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';

import { responseGuard } from '../../lib/responseGuard.js';

/** Minimal express-ish response double that records what was sent. */
function mockRes() {
  const listeners = {};
  const res = {
    statusCode: null,
    body: null,
    headersSent: false,
    writableEnded: false,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.headersSent = true;
      res.writableEnded = true;
      res.body = payload;
      (listeners.finish || []).forEach((fn) => fn());
      return res;
    },
    end() {
      res.headersSent = true;
      res.writableEnded = true;
      (listeners.finish || []).forEach((fn) => fn());
      return res;
    },
    on(event, fn) {
      listeners[event] = listeners[event] || [];
      listeners[event].push(fn);
      return res;
    },
    emit(event) {
      (listeners[event] || []).forEach((fn) => fn());
    },
  };
  return res;
}

describe('responseGuard middleware (SECURITY)', () => {
  test('calls next() immediately so it never delays a normal request', () => {
    const next = jest.fn();
    responseGuard(50)({ method: 'GET', originalUrl: '/x' }, mockRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('forces a 500 when a handler never responds', async () => {
    const res = mockRes();
    responseGuard(20)({ method: 'GET', originalUrl: '/api/admin/getAdminBal' }, res, () => {});

    expect(res.headersSent).toBe(false);

    await new Promise((r) => setTimeout(r, 60));

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ success: false, message: 'Error on server' });
  });

  test('does not double-respond when the handler already answered', async () => {
    const res = mockRes();
    responseGuard(20)({ method: 'GET', originalUrl: '/ok' }, res, () => {});

    res.status(200).json({ success: true });
    expect(res.statusCode).toBe(200);

    await new Promise((r) => setTimeout(r, 60));

    // Still the handler's response, not the guard's 500.
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  test('clears its timer when the client disconnects', async () => {
    const res = mockRes();
    responseGuard(20)({ method: 'GET', originalUrl: '/aborted' }, res, () => {});
    res.emit('close');

    await new Promise((r) => setTimeout(r, 60));

    expect(res.statusCode).toBeNull();
    expect(res.body).toBeNull();
  });

  test('is wired into server.js before the routers', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'server.js'), 'utf8');
    expect(src).toMatch(/responseGuard/);

    const guardAt = src.indexOf('app.use(responseGuard');
    const firstRouterAt = src.indexOf("app.use('/api/auth'");
    expect(guardAt).toBeGreaterThan(-1);
    expect(firstRouterAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(firstRouterAt);
  });
});

describe('user-facing handlers that used to hang', () => {
  // `user.controller#userActivate` and `smslog.controller#getsmslog` were both
  // admin-panel handlers and have been deleted with it. The two survivors keep
  // the shape under test - a handler whose catch block must answer.
  const cases = [
    ['controllers/user.controller.js', 'getUserProfile'],
    ['controllers/user.controller.js', 'requestOTP'],
    ['controllers/notification.controller.js', 'getNotificationHistory_read'],
  ];

  test.each(cases)('%s :: %s responds from its catch block', (file, name) => {
    const src = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
    const start = src.indexOf(`export const ${name} = async (req, res) => {`);
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n};', start));
    const catchBody = body.slice(body.lastIndexOf('} catch'));
    expect(catchBody).toMatch(/return res\s*\n?\s*\.?status\(/);
  });
});

/**
 * Second sweep (this session): handlers that could throw or fall through
 * WITHOUT responding. These are a different shape from the empty-catch bugs
 * above - here the failure is either an `await` sitting outside any try/catch
 * in an async handler (express 4 does not observe a rejected handler promise,
 * so the request is simply never answered), or an if/else chain with no
 * terminal branch.
 *
 * The auth/user/admin controllers cannot be imported under jest because they
 * pull in ../grpc/*.js, which uses `import.meta`. They are covered by source
 * assertions, in the same style as the admin.controller block above.
 */
describe('second sweep: handlers that fell through without responding', () => {
  /**
   * Read one handler's source with comments blanked out.
   *
   * Blanking matters: these assertions are about what the CODE does, and the
   * repaired handlers carry comments that quote the old broken code verbatim
   * ("was: async (err, data) => ...", "the await used to sit outside any
   * try/catch"). Without this, the prose would both mask real regressions and
   * fail assertions the code actually satisfies.
   */
  function readHandler(file, name) {
    const raw = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
    const start = src.indexOf(`export const ${name} = async (req, res`);
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n};', start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  }

  describe('POST /api/auth/register (UNAUTHENTICATED hang primitive)', () => {
    // registerValidate only validates when roleType == 1, so `{}` or
    // `{"roleType":3}` reached createNewUser, matched neither branch, and fell
    // off the end of the function. Verified live: the request hung until the
    // global responseGuard fired, holding a connection for 60s per request.
    const body = readHandler('controllers/auth.controller.js', 'createNewUser');

    test('has a terminal response after the roleType branches', () => {
      // The LAST `return res` before the catch must be the fall-through reply,
      // not one nested inside a roleType branch. Asserting merely that a 400
      // appears somewhere after the last `else if` is not enough: the
      // roleType == 2 branch already returns a 400 of its own, so such an
      // assertion survives deleting the terminal response entirely.
      const catchAt = body.lastIndexOf('} catch');
      expect(catchAt).toBeGreaterThan(-1);
      const beforeCatch = body.slice(0, catchAt);
      const lastReturn = beforeCatch.slice(beforeCatch.lastIndexOf('return res'));
      expect(lastReturn).toMatch(/status\(400\)/);
      expect(lastReturn).toMatch(/Unsupported registration type/);
    });

    test('still responds from its catch block', () => {
      const catchBody = body.slice(body.lastIndexOf('} catch'));
      expect(catchBody).toMatch(/return res\s*\n?\s*\.?status\(500\)/);
    });
  });

  describe('POST /api/auth/forgotPassword', () => {
    // Same shape: the roleType == 2 (SMS) path is commented out, leaving no
    // terminal branch. Currently unreachable behind its validator, but one
    // validator edit away from being live.
    const body = readHandler('controllers/auth.controller.js', 'checkForgotPassword');

    test('has a terminal response after the roleType branch', () => {
      const catchAt = body.lastIndexOf('} catch');
      expect(catchAt).toBeGreaterThan(-1);
      const beforeCatch = body.slice(0, catchAt);
      const lastReturn = beforeCatch.slice(beforeCatch.lastIndexOf('return res'));
      expect(lastReturn).toMatch(/status\(400\)/);
      expect(lastReturn).toMatch(/Unsupported password reset type/);
    });
  });

  describe('GET /api/user/userSetting', () => {
    // Everything after the `err` check ran inside an `async (err, data) =>`
    // mongoose callback. `data.leverage` threw for a user with no UserSetting
    // document, and that rejection was invisible to express.
    const body = readHandler('controllers/user.controller.js', 'getUserSetting');

    test('no longer does its work inside an async mongoose callback', () => {
      expect(body).not.toMatch(/async \(err, data\) =>/);
    });

    test('guards the missing-document case instead of dereferencing null', () => {
      // The specific dereference this was written about - `data.leverage`, set
      // from the caller's open PERPETUAL position - is gone with the derivative
      // engines, so the handler no longer touches `data` at all before
      // answering. The GUARD is what mattered and it must stay: a user with no
      // UserSetting document gets a 404, not a crash express never sees.
      const nullGuardAt = body.indexOf('if (!data)');
      expect(nullGuardAt).toBeGreaterThan(-1);
      expect(body.slice(nullGuardAt)).toMatch(/return res\s*\n?\s*\.?status\(404\)/);

      // And nothing may dereference `data` before that guard runs.
      const beforeGuard = body.slice(0, nullGuardAt);
      expect(beforeGuard).not.toMatch(/\bdata\.\w/);
    });

    test('responds from its catch block', () => {
      const catchBody = body.slice(body.lastIndexOf('} catch'));
      expect(catchBody).toMatch(/return res\s*\n?\s*\.?status\(500\)/);
    });
  });

  /**
   * All three handlers this block used to cover - user.controller#getLoginHistory,
   * admin.controller#getLoginHistory and admin.controller#getAdmin2FA - have
   * been DELETED along with the login-history and 2FA surfaces they served, and
   * so has `getUserList`, the admin user list that stood in for them after
   * that. `deactiveRequest` is the surviving handler of the same shape - it
   * awaits a query, a save and a mail dispatch - and the defect this block
   * exists to catch (an `await` outside any try/catch in an express 4 async
   * handler, which answers nothing at all) is still reachable through it.
   */
  describe('handlers whose awaits used to sit outside any try/catch', () => {
    const cases = [
      ['controllers/user.controller.js', 'deactiveRequest'],
    ];

    test.each(cases)('%s :: %s has every await inside a try', (file, name) => {
      const body = readHandler(file, name);
      const tryAt = body.indexOf('try {');
      const firstAwaitAt = body.indexOf('await ');
      expect(tryAt).toBeGreaterThan(-1);
      expect(firstAwaitAt).toBeGreaterThan(-1);
      expect(tryAt).toBeLessThan(firstAwaitAt);
    });

    test.each(cases)('%s :: %s responds from its catch block', (file, name) => {
      const body = readHandler(file, name);
      const catchBody = body.slice(body.lastIndexOf('} catch'));
      expect(catchBody).toMatch(/return res\s*\n?\s*\.?status\(50\d\)/);
    });
  });

});
