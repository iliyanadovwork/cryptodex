/**
 * Route Authorization Regression Tests (SECURITY)
 *
 * These tests statically analyse routes/*.js and assert that every mounted route
 * is either guarded by `passportAuth` or explicitly listed as intentionally
 * public. They exist because this service shipped several unauthenticated
 * routes that read/mutated user data:
 *
 *   - GET  /api/admin/getsingleuser/:id  -> unauthenticated PII IDOR
 *   - GET  /api/user/test-kyc-verified/:id -> unauthenticated KYC approval backdoor
 *   - *    /api/admin/IpRestriction      -> unauthenticated admin IP allowlist mutation
 *   - POST /api/admin/news-letter        -> unauthenticated mass mail
 *   - GET  /api/admin/getAdminBal        -> unauthenticated + hung forever
 *   - GET  /api/admin/getUserData        -> unauthenticated + hung forever
 *
 * A route file cannot be `import`ed here (the controller graph pulls in gRPC
 * modules that use `import.meta`, which babel-jest cannot transform), so the
 * route table is parsed from source. That is deliberate: the test then also
 * fails when somebody ADDS a new unguarded route, not just when one of the
 * known ones regresses.
 */

import { describe, test, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';

const ROUTES_DIR = path.resolve(process.cwd(), 'routes');

/**
 * Parse `router.route("<path>").<verb>(<handlers>)...` chains out of a route file.
 * Returns [{ file, routePath, method, handlers, guarded }]
 */
function parseRoutes(file) {
  const src = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
  // Strip comments so commented-out routes are not counted.
  const clean = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');

  const routes = [];
  const routeRe = /router\s*\.\s*route\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
  let m;
  while ((m = routeRe.exec(clean)) !== null) {
    const routePath = m[1];
    // Walk forward from the end of .route(...) collecting the chained calls,
    // balancing parentheses, until we hit a `;` at depth 0.
    let i = routeRe.lastIndex;
    let depth = 0;
    let chain = '';
    while (i < clean.length) {
      const ch = clean[i];
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ';' && depth === 0) break;
      // A new `router.route(` at depth 0 means the previous chain was unterminated.
      if (depth === 0 && clean.startsWith('router', i) && chain.trim() !== '') break;
      chain += ch;
      i++;
    }

    const verbRe = /\.\s*(get|post|put|patch|delete|all)\s*\(/g;
    let v;
    while ((v = verbRe.exec(chain)) !== null) {
      const method = v[1].toUpperCase();
      // Capture the argument list for this verb.
      let j = verbRe.lastIndex;
      let d = 1;
      let args = '';
      while (j < chain.length && d > 0) {
        const c = chain[j];
        if (c === '(') d++;
        if (c === ')') d--;
        if (d > 0) args += c;
        j++;
      }
      routes.push({
        file,
        routePath,
        method,
        handlers: args.replace(/\s+/g, ' ').trim(),
        guarded: /\bpassportAuth\b/.test(args),
      });
    }
  }
  return routes;
}

/**
 * Routes that are intentionally reachable without a JWT, with the reason.
 * Anything not on this list MUST carry passportAuth.
 */
const PUBLIC_ALLOWLIST = {
  'auth.route.js': {
    // The whole auth router is pre-authentication by definition.
    '*': 'pre-authentication (register / login / password reset / email confirm)',
  },
  'language.route.js': {
    '/': 'static language list, no user data',
  },
  // 'admin.route.js' IS GONE. The whole admin router - 63 endpoints, several of
  // them writes - was deleted with the admin panel that called it, so there is
  // no longer an admin surface to allowlist anything on.
  'user.route.js': {
    // The ONLY public route left on the user router. It is the branding the
    // frontend reads on every page load, before login (HelperRoute), and it is
    // the same row that brands every outbound e-mail. The rest of what used to
    // be listed here - /getbranddetails, /slider, /faq, /getSupportCategory,
    // /announcement, the three /cms reads, /addContactus and
    // /newsLetter/subscribe - has been removed outright, and two of those were
    // unauthenticated WRITES anyone could fill a collection with.
    '/siteSetting': 'public branding, read by the frontend before login',
    '/emailChange': 'PATCH verifies a signed email-change token from the mailed link',
    // /deactive-req and /deactive-confirm are NOT here any more. They used to
    // be, on the theory that "an OTP sent to the account owner" was gate
    // enough. It was not: the request endpoint accepted an arbitrary email in
    // the body and mailed a live deactivation code to it, so any stranger
    // could trigger a destructive flow against any registered address, and
    // repeat it forever. Both now require passportAuth and act on req.user.id.
  },
  'health.route.js': {
    // Liveness probe. Unauthenticated on purpose: requiring a token would make
    // it useless for the exact case it exists for (process up, auth broken).
    // It reports process/dependency state only - lib/serviceHealth.js is a pure
    // function with no model access, and tests/unit/service-health.test.js
    // pins that privacy contract.
    '/': 'unauthenticated liveness probe, service state only (never user data)',
  },
};

function isAllowlisted(route) {
  const allow = PUBLIC_ALLOWLIST[route.file];
  if (!allow) return false;
  if (allow['*']) return true;
  return Object.prototype.hasOwnProperty.call(allow, route.routePath);
}

describe('Route Authorization (SECURITY)', () => {
  const files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.route.js'));
  const allRoutes = files.flatMap(parseRoutes);

  test('route files are discovered and parsed', () => {
    expect(files.length).toBeGreaterThan(0);
    // Was `> 50`, back when routes/admin.route.js alone declared 63 endpoints.
    // The table is deliberately much smaller now; the number is here to catch a
    // parser that silently matches nothing, not to police the surface size.
    expect(allRoutes.length).toBeGreaterThan(10);
  });

  test('every route is either passportAuth-guarded or explicitly allowlisted as public', () => {
    const unguarded = allRoutes
      .filter((r) => !r.guarded && !isAllowlisted(r))
      .map((r) => `${r.method} ${r.file}${r.routePath} [handlers: ${r.handlers}]`);

    expect(unguarded).toEqual([]);
  });

  describe('previously exploitable routes are now guarded', () => {
    // The nine admin.route.js entries that used to head this list -
    // /getsingleuser/:id (an unauthenticated PII IDOR), /getAdminBal,
    // /getUserData, /getDashChart, /news-letter (unauthenticated mass mail),
    // /getTemplate/:id, /getcms/:id and /getcategory/:id - are no longer
    // guarded. They no longer EXIST; the whole admin router is deleted, which
    // the absence assertions below now pin.
    const mustBeGuarded = [
      // Unauthenticated destructive trigger: POST /deactive-req with any
      // registered email mailed that address a live deactivation code, and
      // POST /deactive-confirm with that code shredded the account.
      ['user.route.js', '/deactive-req', 'POST'],
      ['user.route.js', '/deactive-confirm', 'POST'],
    ];

    test.each(mustBeGuarded)('%s %s (%s) requires a session', (file, routePath, method) => {
      const route = allRoutes.find(
        (r) => r.file === file && r.routePath === routePath && r.method === method
      );
      expect(route).toBeDefined();
      expect(route.guarded).toBe(true);
    });
  });

  /**
   * THE WHOLE IDENTITY / SECURITY SURFACE IS GONE, NOT JUST ITS BACKDOOR.
   *
   * This block used to check three narrow facts about ONE hole - that the
   * unauthenticated `GET /test-kyc-verified/:id` KYC-approval backdoor no longer
   * had a route, a reference or a handler. There is now no KYC at all, so the
   * check is widened to the whole surface: 2FA enrolment, the anti-phishing
   * code, the login journal, the login IP blocklist and every KYC endpoint.
   *
   * Absence is asserted at the ROUTE TABLE and at the FILESYSTEM, because those
   * fail differently: a route left behind after its handler is deleted crashes
   * the service at boot (`Route.post() requires a callback function but got
   * undefined` - which is exactly what happened once during this removal), and
   * a handler left behind after its route is deleted is a live endpoint nobody
   * is looking at.
   */
  describe('the identity and security surface is gone (paper trading)', () => {
    const removedRoutes = [
      '/2fa', '/2fa-status', '/2fa-data', '/disable-2fa', '/getAdmin-2FA',
      '/antiphishingcode',
      '/IpRestriction',
      '/loginHistory', '/login-history', '/sub-login-history', '/userLoginHist',
      '/kyc', '/kyc/idproof', '/kyc/addressproof', '/kycdetail', '/userKyc',
      '/userKycDetails', '/userKycRejections', '/kyc-webhook', '/forceRejectKyc',
      '/accessToken', '/test-kyc-verified/:id',
    ];

    test.each(removedRoutes)('no route declares %s', (routePath) => {
      const found = allRoutes.filter((r) => r.routePath === routePath);
      expect(found.map((r) => `${r.method} ${r.file}${r.routePath}`)).toEqual([]);
    });

    test.each([
      'controllers/userKyc.controller.js',
      'controllers/sumsubkyc.controller.js',
      'validation/userKyc.validation.js',
      'lib/twoFactor.js',
    ])('%s no longer exists', (rel) => {
      expect(fs.existsSync(path.resolve(process.cwd(), rel))).toBe(false);
    });

    test('no route file still imports a deleted controller or validator', () => {
      const offenders = [];
      for (const file of files) {
        const src = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
        for (const gone of ['userKyc.controller', 'sumsubkyc.controller', 'userKyc.validation', 'twoFactor.js']) {
          if (new RegExp(`^import[^\n]*${gone.replace('.', '\\.')}`, 'm').test(src)) {
            offenders.push(`${file} -> ${gone}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });

    test('LOGIN STILL WORKS: no login path calls a second-factor gate', () => {
      // The point of removing 2FA is that sign-in gets simpler, not that it
      // breaks. If a `sendTwoFactorRefusal` call survived without its module,
      // every login would 500 at the first request rather than at boot.
      const src = fs.readFileSync(
        path.resolve(process.cwd(), 'controllers/auth.controller.js'),
        'utf8'
      );
      expect(src).not.toMatch(/sendTwoFactorRefusal\s*\(/);
      expect(src).not.toMatch(/^import .*twoFactor\.js/m);
      // and the routes it protects are still registered
      const login = allRoutes.find((r) => r.file === 'auth.route.js' && r.routePath === '/login');
      expect(login).toBeDefined();
    });
  });

  describe('gas station custody routes are gone (paper trading)', () => {
    test('no route mentions gas-station', () => {
      const found = allRoutes.filter((r) => /gas-?station/i.test(r.routePath));
      expect(found).toEqual([]);
    });
  });

  /**
   * THE ADMIN PANEL IS GONE, SO ITS API IS GONE.
   *
   * This block used to assert the opposite: that the five routes the panel
   * called before login stayed public. The panel has been deleted, and with it
   * every one of the 63 endpoints on /api/admin - a whole router of live HTTP
   * handlers, several of them writes (user lock/unlock, fee overrides, CMS and
   * template edits, mass mail), that no UI could reach and nobody was watching.
   *
   * Absence is asserted three ways because they fail differently: a surviving
   * ROUTE FILE is a live surface; a surviving MOUNT in server.js with no file
   * crashes the service at boot; and a surviving passport strategy is dead
   * auth code that invites the routes back.
   */
  describe('the admin API is gone (paper trading)', () => {
    test('there is no admin route file', () => {
      expect(files).not.toContain('admin.route.js');
      expect(fs.existsSync(path.resolve(process.cwd(), 'routes/admin.route.js'))).toBe(false);
    });

    test.each([
      'controllers/admin.controller.js',
      'controllers/support.controller.js',
      'controllers/faq.controller.js',
      'controllers/cms.controller.js',
      'controllers/common.controller.js',
      'controllers/smslog.controller.js',
      'controllers/anouncement.controller.js',
      'validation/admin.validation.js',
      'validation/support.validation.js',
      'validation/emailTemplate.validation.js',
      'validation/siteSettings.validation.js',
      'lib/smsGateway.js',
      'createSuperAdmin.js',
    ])('%s no longer exists', (rel) => {
      expect(fs.existsSync(path.resolve(process.cwd(), rel))).toBe(false);
    });

    test('server.js mounts no admin router and installs no admin strategy', () => {
      const src = fs.readFileSync(path.resolve(process.cwd(), 'server.js'), 'utf8');
      expect(src).not.toMatch(/admin\.route/);
      expect(src).not.toMatch(/\/api\/admin/);
      expect(src).not.toMatch(/adminAuth/);
    });

    test('config/passport.js no longer registers an adminAuth strategy', () => {
      const src = fs.readFileSync(path.resolve(process.cwd(), 'config/passport.js'), 'utf8');
      expect(src).not.toMatch(/passport\.use\(\s*\n?\s*["']adminAuth["']/);
    });

    test('no route file guards anything with adminAuth', () => {
      for (const file of files) {
        const src = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
        expect(src).not.toMatch(/adminAuth/);
      }
    });
  });

  /**
   * THE SUPPORT DESK, THE CMS, THE MARKETING SURFACE AND PHONE/OTP ARE GONE.
   *
   * Same reasoning as the identity block above: a route left behind after its
   * handler is deleted crashes the service at boot, and a handler left behind
   * after its route is deleted is a live endpoint nobody is looking at. These
   * are asserted at the route table.
   *
   * /siteSetting and /setting are deliberately NOT in this list. /siteSetting
   * is the branding the frontend reads on every page and the same row that
   * brands every outbound e-mail; /setting is the per-user preferences document
   * the trade screen reads. Both survive - see the allowlist above.
   */
  describe('the support / CMS / marketing / phone surface is gone', () => {
    const removedRoutes = [
      '/support', '/getSupportCategory', '/supportCategory', '/ticketList',
      '/faq', '/faqCategory', '/getFaqCategory',
      '/cms/:identifier', '/home-cms/:identifier', '/cmcContent/:identifier',
      '/announcement', '/anouncement',
      '/addContactus', '/contactus', '/newsLetter/subscribe', '/news-letter',
      '/slider', '/getbranddetails',
      '/emailTemplate', '/getemailintegrate', '/updatemailintegrate',
      '/updatesmsconfig', '/smslog',
      '/rolemanage', '/modules', '/submodules', '/sub-admin', '/getrole',
      '/getsinglerole/:id', '/subAdmin/:id',
      '/phoneChange', '/verifyOtp',
    ];

    test.each(removedRoutes)('no route declares %s', (routePath) => {
      const found = allRoutes.filter((r) => r.routePath === routePath);
      expect(found.map((r) => `${r.method} ${r.file}${r.routePath}`)).toEqual([]);
    });

    test('PASSWORD CHANGE STILL WORKS: /changePassword and its e-mail code survive', () => {
      // /sendOTP is deliberately KEPT (e-mail only). changePassword verifies
      // the mailed code before it will rotate a password, so deleting the route
      // that issues that code would have made password change impossible - and
      // password change is on the regression baseline.
      const changePw = allRoutes.find(
        (r) => r.file === 'user.route.js' && r.routePath === '/changePassword'
      );
      expect(changePw).toBeDefined();
      expect(changePw.guarded).toBe(true);

      const sendOtp = allRoutes.find(
        (r) => r.file === 'user.route.js' && r.routePath === '/sendOTP'
      );
      expect(sendOtp).toBeDefined();
      expect(sendOtp.guarded).toBe(true);

      // and no SMS is left behind it
      const src = fs.readFileSync(
        path.resolve(process.cwd(), 'controllers/user.controller.js'),
        'utf8'
      );
      expect(src).not.toMatch(/^import .*smsGateway/m);
      expect(src).not.toMatch(/\bsentSms\s*\(/);
    });

    test('LOGIN STILL WORKS: the e-mail login code is untouched', () => {
      // /auth/verifyOtp (the PHONE code) is gone; the login OTP is verified
      // inside POST /login itself and re-issued by POST /resend-otp.
      const login = allRoutes.find((r) => r.file === 'auth.route.js' && r.routePath === '/login');
      const resend = allRoutes.find(
        (r) => r.file === 'auth.route.js' && r.routePath === '/resend-otp'
      );
      expect(login).toBeDefined();
      expect(resend).toBeDefined();
    });
  });
});
