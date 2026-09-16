import { test, expect } from '@playwright/test';
import { registerAccount, signIn, TestAccount } from './faucet-account';

/**
 * E2E: THE DEMO FAUCET (/faucet)
 * ==============================
 *
 * There is no deposit on this venue. `/deposit` is a redirect to `/faucet`
 * (next.config.js), and the page renders components/Wallet/FaucetForm.tsx: a
 * claim screen that credits 1,000 USDC + 1,000 USD to the spot wallet once
 * every 24 hours. No addresses, no QR codes, no networks.
 *
 * WHAT THIS FILE USED TO SAY, AND WHY IT WAS REWRITTEN. It asserted a product
 * two rounds out of date and had been failing for both reasons:
 *
 *   - it expected "Claim 10,000 demo USDC", "Claim Demo USDC" and "Your USDC
 *     Balance:". The grant was corrected to 1,000 (the pages promised 10,000
 *     while the server credited 1,000) and the page now names BOTH coins;
 *   - it ran SIGNED OUT and asserted a "Please Log In" panel, because /deposit
 *     was not middleware-protected. /faucet is now in `protectedRoutes`, so a
 *     signed-out visitor is sent to /login rather than being shown a wallet
 *     screen wrapped around 401s.
 *
 * It also pins the defect this round fixed: the demo-credit table under the
 * claim was reading `spot/getDepositHistory`, a route deleted with the custody
 * surface, so it printed "No Records Found" to accounts that had just claimed.
 * The rows exist - the faucet writes one per credited coin - and the table has
 * to show them.
 *
 * Prerequisites: frontend on BASE_URL, userapi on E2E_USER_API, spotapi and
 * walletapi up. The account is created by the spec.
 */

test.describe('the faucet is behind a login', () => {
  test('a signed-out visitor is sent to /login, not shown the claim screen', async ({
    page,
  }) => {
    await page.goto('/faucet');
    await page.waitForURL(/\/login/);
    expect(page.url()).toContain('/login');
  });

  test('the old /deposit URL still resolves, and is guarded too', async ({ page }) => {
    await page.goto('/deposit');
    await page.waitForURL(/\/login/);
    expect(page.url()).toContain('/login');
  });

  test('and so is /wallet', async ({ page }) => {
    await page.goto('/wallet');
    await page.waitForURL(/\/login/);
    expect(page.url()).toContain('/login');
  });
});

test.describe('Demo Funds Claim Page', () => {
  let account: TestAccount;

  test.beforeAll(async () => {
    account = await registerAccount();
  });

  test.beforeEach(async ({ page }) => {
    await signIn(page, account);
    await page.goto('/faucet', { waitUntil: 'domcontentloaded' });
    await expect(
      page.getByRole('heading', { name: 'Claim Demo Funds' })
    ).toBeVisible({ timeout: 20000 });
  });

  test('shows the claim screen and the shortcut to the reset page', async ({ page }) => {
    await expect(page.getByText('Paper Trading', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /reset account/i })).toBeVisible();
  });

  test('states the balance it is topping up, both coins', async ({ page }) => {
    await expect(page.getByText('Your Spot Balance:')).toBeVisible();
    // Both faucet coins are shown, because every spot pair settles in USD and
    // the claim credits both. A fresh account is seeded with 1,000 of each.
    await expect(page.getByRole('heading', { name: /USDC$/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /\bUSD$/ })).toBeVisible();
  });

  test('says what a claim is worth, and says the same thing twice over', async ({
    page,
  }) => {
    // The grant is stated on the card and again in the sidebar. It said 10,000
    // in both places while the server credited 1,000; the figure now comes from
    // one constant (lib/faucetReceipt FAUCET_SPOT_GRANT) so the two cannot
    // drift apart again.
    await expect(
      page.getByText(/1,000 USDC \+ 1,000 USD to your spot wallet/)
    ).toBeVisible();
    await expect(page.getByText('About Demo Funds')).toBeVisible();
    await expect(
      page.getByText(/1,000 USDC \+ 1,000 USD are credited instantly/)
    ).toBeVisible();
    await expect(page.getByText(/claim once every 24 hours/i).first()).toBeVisible();
  });

  test('carries the paper-trading disclaimers', async ({ page }) => {
    const banner = page.locator('.paper_trading_banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/virtual funds only/i);
    await expect(
      page.getByText(/Demo funds are virtual and have\s*no real-world value/)
    ).toBeVisible();
  });

  test('an account that has never claimed says so, rather than looking broken', async ({
    page,
  }) => {
    // The account is fresh: its 1,000 + 1,000 was seeded by walletapi when the
    // wallet was created, which is not a claim and writes no row. "No Records
    // Found" over a funded wallet is indistinguishable from a table that failed
    // to load - and for as long as the route behind it was deleted, that IS
    // what it was.
    await expect(
      page.getByRole('heading', { name: 'Demo credit history' })
    ).toBeVisible();
    await expect(page.getByText('No claims yet')).toBeVisible({ timeout: 20000 });
    await expect(page.getByText('No Records Found')).toHaveCount(0);

    const viewMore = page.getByRole('link', { name: /view more/i });
    await expect(viewMore).toHaveAttribute('href', '/history?type=deposit');
  });

  test('a claim is on the record immediately, and on /history too', async ({ page }) => {
    // THE REGRESSION THIS EXISTS FOR. The table read spot/getDepositHistory,
    // which had been deleted; the request 404'd, the component swallowed it and
    // rendered an empty table to an account whose claim HAD been recorded - one
    // row per credited coin, written by the faucet in the same call that moved
    // the balance. It reads spot/faucet/history now.
    //
    // ON ITS OWN ACCOUNT, deliberately: the faucet has a 24h cooldown, so a
    // retry - or a second run of this file - would meet a 429 on the shared
    // account and fail for a reason that has nothing to do with the history.
    const claimer = await registerAccount();
    await signIn(page, claimer);
    await page.goto('/faucet', { waitUntil: 'domcontentloaded' });
    await expect(
      page.getByRole('heading', { name: 'Claim Demo Funds' })
    ).toBeVisible({ timeout: 20000 });

    await page.getByTestId('faucet-claim-button').click();

    const table = page.locator('table').last();
    await expect(table).toContainText('Demo credit', { timeout: 30000 });
    await expect(table).toContainText('USDC');
    await expect(table).toContainText('Spot wallet');

    // The same rows, from the same endpoint, on the history page.
    await page.goto('/history?type=deposit', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Demo Credits')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('table').first()).toContainText('Demo credit', {
      timeout: 30000,
    });
  });

  test('renders no custody deposit UI at all', async ({ page }) => {
    await expect(page.getByPlaceholder(/address/i)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /copy address/i })).toHaveCount(0);
    await expect(page.getByText(/TRC20|ERC20|BEP20/)).toHaveCount(0);
    await expect(page.getByText(/minimum deposit/i)).toHaveCount(0);
    await expect(page.getByText(/block confirmations/i)).toHaveCount(0);
  });
});
