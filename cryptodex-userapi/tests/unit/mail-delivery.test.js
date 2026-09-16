/**
 * Outbound Email Delivery Policy Tests (SECURITY / AVAILABILITY)
 *
 * Context: the provider was rejecting every send, which bricked registration
 * and password reset locally, because both flows require a link that only
 * arrives by email. The fix renders and LOGS the mail in non-production instead
 * of sending it.
 *
 * The security-critical property is the direction of the default: production
 * must keep sending real email no matter what the other flags say, and the
 * bypass must never switch itself on just because NODE_ENV happens to be unset.
 * Those two are the guards these tests exist to hold.
 */

import { describe, test, expect, jest, afterEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';

import {
  DELIVERY_LOG_ONLY,
  DELIVERY_SEND,
  isProduction,
  isMailBypassed,
  mailDeliveryMode,
  mailDeliveryFacts,
  discloseWhenLogOnly,
  extractActionLinks,
  summariseTemplate,
  logMailInsteadOfSending,
} from '../../lib/mailDelivery.js';

import { sendEmail } from '../../lib/emailGateway.js';

describe('mailDeliveryMode - production veto (SECURITY)', () => {
  test('production sends for real even when every bypass flag is set', () => {
    const env = {
      NODE_ENV: 'production',
      TEST_MODE: 'true',
      DEV_EMAIL_BYPASS: 'true',
    };
    expect(mailDeliveryMode(env)).toBe(DELIVERY_SEND);
    expect(isMailBypassed(env)).toBe(false);
    expect(isProduction(env)).toBe(true);
  });

  test('the veto is checked before the opt-in, so no flag ordering can defeat it', () => {
    // Each opt-in signal, individually, must still lose to production.
    for (const flag of [
      { NODE_ENV: 'production', TEST_MODE: 'true' },
      { NODE_ENV: 'production', DEV_EMAIL_BYPASS: 'true' },
    ]) {
      expect(mailDeliveryMode(flag)).toBe(DELIVERY_SEND);
    }
  });
});

describe('mailDeliveryMode - the bypass requires a positive opt-in (SECURITY)', () => {
  test('an unset NODE_ENV alone does NOT enable the bypass', () => {
    // A deploy that merely forgot NODE_ENV must still mail its users.
    expect(mailDeliveryMode({})).toBe(DELIVERY_SEND);
  });

  test('development without an opt-in flag still sends', () => {
    expect(mailDeliveryMode({ NODE_ENV: 'development' })).toBe(DELIVERY_SEND);
  });

  test('a non-"true" TEST_MODE value does not enable the bypass', () => {
    expect(mailDeliveryMode({ NODE_ENV: 'development', TEST_MODE: '1' })).toBe(
      DELIVERY_SEND
    );
    expect(mailDeliveryMode({ NODE_ENV: 'development', TEST_MODE: 'yes' })).toBe(
      DELIVERY_SEND
    );
  });
});

describe('mailDeliveryMode - accepted non-production opt-in signals', () => {
  test.each([
    ['NODE_ENV=test', { NODE_ENV: 'test' }],
    ['TEST_MODE=true', { NODE_ENV: 'development', TEST_MODE: 'true' }],
    ['DEV_EMAIL_BYPASS=true', { NODE_ENV: 'development', DEV_EMAIL_BYPASS: 'true' }],
  ])('%s puts delivery in log-only mode', (_label, env) => {
    expect(mailDeliveryMode(env)).toBe(DELIVERY_LOG_ONLY);
    expect(isMailBypassed(env)).toBe(true);
  });
});

describe('extractActionLinks', () => {
  test('pulls the activation link out of a rendered template', () => {
    const html = `
      <p>Hi</p>
      <a href="http://localhost:3000/verification/register?auth=abc123">Activate</a>
      <img src="http://localhost:2567/emailimages/twiter.png" />
    `;
    expect(extractActionLinks(html)).toEqual([
      'http://localhost:3000/verification/register?auth=abc123',
    ]);
  });

  test('pulls the password reset link and de-duplicates repeats', () => {
    const url = 'http://localhost:3000/verification/forgotPassword?auth=tok';
    const html = `<a href="${url}">Reset</a> or copy ${url}`;
    expect(extractActionLinks(html)).toEqual([url]);
  });

  test('ignores decorative asset URLs that carry no token', () => {
    const html = '<img src="http://localhost:2567/emailimages/facbook.png" />';
    expect(extractActionLinks(html)).toEqual([]);
  });

  test('is safe on empty or non-string input', () => {
    expect(extractActionLinks('')).toEqual([]);
    expect(extractActionLinks(undefined)).toEqual([]);
    expect(extractActionLinks(null)).toEqual([]);
  });
});

describe('summariseTemplate', () => {
  test('flattens HTML so a code-bearing mail is still usable locally', () => {
    const html = '<html><body><h1>Your code</h1><p>  123456  </p></body></html>';
    expect(summariseTemplate(html)).toBe('Your code 123456');
  });

  test('drops script and style content', () => {
    const html = '<style>a{color:red}</style><script>alert(1)</script><p>hello</p>';
    expect(summariseTemplate(html)).toBe('hello');
  });

  test('truncates long bodies', () => {
    const html = `<p>${'x'.repeat(900)}</p>`;
    const out = summariseTemplate(html, 100);
    expect(out).toHaveLength(103); // 100 chars + '...'
    expect(out.endsWith('...')).toBe(true);
  });
});

describe('logMailInsteadOfSending', () => {
  test('reports the mail as NOT delivered, so nothing downstream claims success', () => {
    const log = jest.fn();
    const result = logMailInsteadOfSending(
      'dev@example.com',
      {
        subject: 'Activate your account',
        template: '<a href="http://localhost:3000/verification/register?auth=tok">go</a>',
      },
      { log }
    );

    expect(result.delivered).toBe(false);
    expect(result.mode).toBe(DELIVERY_LOG_ONLY);
    expect(result.links).toEqual([
      'http://localhost:3000/verification/register?auth=tok',
    ]);
  });

  test('writes the recipient, subject and link so the flow can be completed by hand', () => {
    const log = jest.fn();
    logMailInsteadOfSending(
      'dev@example.com',
      {
        subject: 'Activate your account',
        template: '<a href="http://localhost:3000/verification/register?auth=tok">go</a>',
      },
      { log }
    );

    const written = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(written).toContain('dev@example.com');
    expect(written).toContain('Activate your account');
    expect(written).toContain('http://localhost:3000/verification/register?auth=tok');
    expect(written).toContain('NOT SENT');
  });

  test('falls back to a body digest when the mail carries a code, not a link', () => {
    const log = jest.fn();
    logMailInsteadOfSending(
      'dev@example.com',
      { subject: 'Your OTP', template: '<p>Your code is 654321</p>' },
      { log }
    );

    const written = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(written).toContain('654321');
  });
});

describe('sendEmail honours the delivery policy (SECURITY)', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.DEV_EMAIL_BYPASS;
  });

  test('in log-only mode it never contacts the provider', async () => {
    // NODE_ENV is 'test' under jest, so the bypass is active.
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy;

    const result = await sendEmail('dev@example.com', {
      subject: 'Activate',
      template: '<a href="http://localhost:3000/verification/register?auth=t">go</a>',
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.mode).toBe(DELIVERY_LOG_ONLY);
    expect(result.delivered).toBe(false);
  });

  test('it resolves rather than rejecting, because every caller is fire-and-forget', async () => {
    global.fetch = jest.fn();
    await expect(
      sendEmail('dev@example.com', { subject: 's', template: '<p>t</p>' })
    ).resolves.toBeDefined();
  });
});

describe('the send path has no retry (AVAILABILITY)', () => {
  test('emailGateway does not loop or re-issue a failed provider call', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'lib/emailGateway.js'),
      'utf8'
    );
    // A retry here would multiply traffic during exactly the quota outage it
    // was meant to survive, and callers never await it so it would be invisible.
    expect(src).not.toMatch(/\bfor\s*\(/);
    expect(src).not.toMatch(/\bwhile\s*\(/);
    expect(src).not.toMatch(/setTimeout/);
    expect((src.match(/await fetch\(/g) || []).length).toBe(1);
  });

  test('a provider rejection is logged at error level, not swallowed', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'lib/emailGateway.js'),
      'utf8'
    );
    expect(src).toMatch(/console\.error/);
    // The old code did `console.log("-----err on sendEmail", err)` and returned
    // undefined, so an outage was completely silent.
    expect(src).not.toMatch(/-----err on sendEmail/);
  });
});


/**
 * WHAT THE HTTP REPLY IS ALLOWED TO CLAIM.
 * ========================================
 *
 * `POST /api/auth/register` answered "Activation mail sent. Please check your
 * email and click the activation link" whatever the delivery mode was, and the
 * register form built "Check your spam folder if it does not arrive." on top of
 * it. With `TEST_MODE=true` - which is set in this service's local.env - the
 * mail is rendered and LOGGED and no provider is ever contacted, so there was
 * no message and no spam folder to look in.
 *
 * These pin BOTH directions. Asserting only the local environment would let
 * `delivered` be hardcoded to `false`, which would make production claim it had
 * sent nothing.
 */
describe('mailDeliveryFacts - the reply must match the mode, in both directions', () => {
  test('production: delivered is TRUE and there is no notice to show', () => {
    const facts = mailDeliveryFacts({ NODE_ENV: 'production' });
    expect(facts.delivered).toBe(true);
    expect(facts.mailDelivery).toBe(DELIVERY_SEND);
    expect(facts.mailNotice).toBe('');
  });

  test('production wins even with every bypass flag set - delivered stays TRUE', () => {
    const facts = mailDeliveryFacts({
      NODE_ENV: 'production',
      TEST_MODE: 'true',
      DEV_EMAIL_BYPASS: 'true',
    });
    expect(facts.delivered).toBe(true);
    expect(facts.mailNotice).toBe('');
  });

  test('an unset NODE_ENV still sends, so delivered is TRUE', () => {
    const facts = mailDeliveryFacts({});
    expect(facts.delivered).toBe(true);
    expect(facts.mailDelivery).toBe(DELIVERY_SEND);
  });

  test.each([
    ['NODE_ENV=test', { NODE_ENV: 'test' }],
    ['TEST_MODE=true', { NODE_ENV: 'development', TEST_MODE: 'true' }],
    ['DEV_EMAIL_BYPASS=true', { NODE_ENV: 'development', DEV_EMAIL_BYPASS: 'true' }],
  ])('%s: delivered is FALSE and the notice says nothing was sent', (_name, env) => {
    const facts = mailDeliveryFacts(env);
    expect(facts.delivered).toBe(false);
    expect(facts.mailDelivery).toBe(DELIVERY_LOG_ONLY);
    expect(facts.mailNotice).toMatch(/no message was sent/i);
    expect(facts.mailNotice).not.toMatch(/spam/i);
  });

  test('delivered tracks the mode rather than being a constant', () => {
    const on = mailDeliveryFacts({ NODE_ENV: 'production' }).delivered;
    const off = mailDeliveryFacts({ NODE_ENV: 'test' }).delivered;
    expect(on).not.toBe(off);
  });
});

/**
 * DISCLOSING THE SECRET WE COULD NOT DELIVER (SECURITY)
 * ====================================================
 * `mailDeliveryFacts` stopped the product LYING ("mail sent") but not the dead
 * end: the activation link, the reset link and the change-password code all
 * left the building only by e-mail, so in log-only mode they reached the
 * process log and nowhere a user could read them. A forgotten password was
 * permanent. `discloseWhenLogOnly` returns those values to the caller - but
 * ONLY when nothing was sent.
 *
 * That makes it a security boundary, so it is pinned in BOTH directions.
 * Asserting only that the local stack discloses would let the guard be deleted
 * entirely without a test noticing; the tests that matter most here are the
 * ones that demand `{}`.
 */
describe('discloseWhenLogOnly - the production side of the guard (SECURITY)', () => {
  test('production discloses NOTHING', () => {
    expect(
      discloseWhenLogOnly({ resetLink: 'https://x/verification/forgotPassword?auth=T' }, {
        NODE_ENV: 'production',
      })
    ).toEqual({});
  });

  test('no combination of bypass flags can make production disclose', () => {
    for (const env of [
      { NODE_ENV: 'production', TEST_MODE: 'true' },
      { NODE_ENV: 'production', DEV_EMAIL_BYPASS: 'true' },
      { NODE_ENV: 'production', TEST_MODE: 'true', DEV_EMAIL_BYPASS: 'true' },
    ]) {
      expect(discloseWhenLogOnly({ verificationCode: '123456' }, env)).toEqual({});
    }
  });

  test('an unset NODE_ENV sends for real, so it discloses nothing either', () => {
    // Same safe direction as mailDeliveryMode: a deploy that forgot NODE_ENV
    // must not start publishing reset links.
    expect(discloseWhenLogOnly({ resetLink: 'https://x/y' }, {})).toEqual({});
  });

  test('disclosure tracks the mode rather than being a constant', () => {
    const secret = { resetLink: 'https://x/y' };
    expect(discloseWhenLogOnly(secret, { NODE_ENV: 'production' })).toEqual({});
    expect(discloseWhenLogOnly(secret, { NODE_ENV: 'test' })).toEqual(secret);
  });
});

describe('discloseWhenLogOnly - what it hands back locally', () => {
  test.each([
    ['NODE_ENV=test', { NODE_ENV: 'test' }],
    ['TEST_MODE=true', { NODE_ENV: 'development', TEST_MODE: 'true' }],
    ['DEV_EMAIL_BYPASS=true', { NODE_ENV: 'development', DEV_EMAIL_BYPASS: 'true' }],
  ])('%s: the caller gets the value it could not mail', (_name, env) => {
    expect(
      discloseWhenLogOnly({ activationLink: 'https://x/verification/register?auth=T' }, env)
    ).toEqual({ activationLink: 'https://x/verification/register?auth=T' });
  });

  test('empty and absent values are dropped, not published as blanks', () => {
    // A page that switches on "did the server give me a link" must not be sent
    // down the yes branch by `resetLink: ""`.
    expect(
      discloseWhenLogOnly(
        { resetLink: '', verificationCode: undefined, activationLink: null, good: 'x' },
        { NODE_ENV: 'test' }
      )
    ).toEqual({ good: 'x' });
  });

  test('a non-object disclosure is ignored rather than spread', () => {
    expect(discloseWhenLogOnly(null, { NODE_ENV: 'test' })).toEqual({});
    expect(discloseWhenLogOnly('resetLink', { NODE_ENV: 'test' })).toEqual({});
  });
});
