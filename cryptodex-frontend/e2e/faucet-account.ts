import { Page } from '@playwright/test';

/**
 * A THROWAWAY ACCOUNT, PROVISIONED THE WAY THE PRODUCT PROVISIONS ONE.
 *
 * The two faucet specs used to be written to run SIGNED OUT, because /deposit
 * and /withdraw were unguarded and rendered a login prompt in place of their
 * controls. Both pages are now behind the edge middleware (/faucet and /reset
 * are in `protectedRoutes`), which is the point: a signed-out visitor is sent
 * to /login instead of watching a wallet screen render around a series of 401s.
 *
 * So a spec about those pages needs a session, and taking one from
 * E2E_TEST_EMAIL leaves the suite passing only on the machine that happens to
 * have that account. This registers a fresh one over the API - the same two
 * calls the sign-up flow makes - and signs in through the real form.
 *
 * `auth/test-verify` exists because e-mail delivery is switched off on a local
 * stack; it is the same activation the mailed link performs.
 */

const USER_API = process.env.E2E_USER_API || 'http://localhost:2567/api';

export interface TestAccount {
  email: string;
  password: string;
}

export async function registerAccount(): Promise<TestAccount> {
  const email = `e2e-faucet-${Date.now()}-${Math.floor(Math.random() * 1e4)}@test.com`;
  const password = 'SmokeTest123!';

  const post = async (path: string, body: any) => {
    const res = await fetch(`${USER_API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  };

  await post('/auth/register', {
    email,
    password,
    confirmPassword: password,
    roleType: 1,
    checkbox: true,
  });
  await post('/auth/test-verify', { email });

  return { email, password };
}

/** Sign in through the real login form and wait for the session to settle. */
export async function signIn(page: Page, account: TestAccount) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="email"]', account.email);
  await page.fill('input[name="password"]', account.password);
  await page.getByRole('button', { name: /log in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), {
    timeout: 30000,
  });
}
