/**
 * Client API fallbacks and the SSR-safe bundling of react-toastify.
 *
 * 1. STALE FALLBACK PORTS
 *    config/index.js reads `NEXT_PUBLIC_*`; the checked-in local.env / prod.env
 *    spell every key with a DOUBLE underscore (`NEXT_PUBLIC__AFFILIATE_API`),
 *    so those files never reach the config object. What saves the running dev
 *    server is `.env.local`, which uses the single-underscore spelling - and
 *    `.env.local` is gitignored (.gitignore line 37, `.env.*`). On any checkout
 *    without it the fallbacks in config/index.js ARE the configuration, and
 *    three of them pointed at ports nothing binds: 2570 (futures), 2571
 *    (inverse), 4573 (affiliate) instead of 3005 / 3006 / 3008. Both the REST
 *    calls and the socket.io connections use these values, so the pages that
 *    read them rendered permanently empty.
 *
 *    The two derivative engines have since been removed from the venue, and
 *    FUTURES_API / INVERSE_API with them; the affiliate programme followed, and
 *    AFFILIATE_API with it. The port guard below is KEPT and widened rather
 *    than deleted: 3005, 3006 and 3008 must not reappear either, since nothing
 *    the frontend can reach is listening on them any more.
 *
 *    `@/config` is mocked globally in jest.setup.js, so this asserts against
 *    the source of config/index.js rather than the imported object.
 *
 * 2. react-toastify AS AN ESM EXTERNAL
 *    The package exposes an ESM entry, so Next's default `esmExternals` left it
 *    out of the server bundle and Node imported it natively at request time.
 *    That import never sees webpack's `react` alias, so toastify called hooks
 *    on a SECOND copy of React whose dispatcher is null, and every SSR of
 *    <ToastContainer/> (mounted in _app, so every page plus the /_error render
 *    that follows) threw "Cannot read properties of null (reading
 *    'useReducer')". `transpilePackages` pulls it back into the webpack build.
 */

import fs from 'fs';
import path from 'path';

const configSource = fs.readFileSync(
  path.join(__dirname, '..', '..', 'config', 'index.js'),
  'utf8'
);

const fallbackFor = (name: string): string | null => {
  const m = configSource.match(
    new RegExp(`${name}:\\s*process\\.env\\.\\w+\\s*\\|\\|\\s*"([^"]+)"`)
  );
  return m ? m[1] : null;
};

describe('config/index.js fallbacks', () => {
  it('no longer configures the removed engines or the affiliate service', () => {
    // A fallback here is what a checkout without .env.local actually uses, so
    // leaving one behind is an invitation to point a new call site at a service
    // that is not running. The two derivative engines went with their pages;
    // AFFILIATE_API went with the affiliate programme, which had no plans, no
    // commission rates and no enrolments to serve.
    expect(fallbackFor('FUTURES_API')).toBeNull();
    expect(fallbackFor('INVERSE_API')).toBeNull();
    expect(fallbackFor('AFFILIATE_API')).toBeNull();
  });

  it('leaves the spot / user / wallet fallbacks alone', () => {
    expect(fallbackFor('USER_API')).toBe('http://localhost:2567');
    expect(fallbackFor('SPOT_API')).toBe('http://localhost:2568');
    expect(fallbackFor('WALLET_API')).toBe('http://localhost:3002');
  });

  it('never falls back to a port no service listens on', () => {
    // 2570 / 2571 / 4573 were never bound by anything; 3005 / 3006 were the
    // perpetual and inverse engines and 3008 the affiliate service, none of
    // which this frontend talks to any more.
    for (const port of ['2570', '2571', '4573', '3005', '3006', '3008']) {
      expect(configSource).not.toContain(`localhost:${port}`);
    }
  });
});

describe('next.config.js', () => {
  const nextConfig = require('../../next.config.js');

  it('bundles react-toastify instead of letting Node import it as an ESM external', () => {
    expect(nextConfig.transpilePackages).toContain('react-toastify');
  });
});
