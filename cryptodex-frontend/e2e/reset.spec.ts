import { test, expect } from '@playwright/test';
import { registerAccount, signIn, TestAccount } from './faucet-account';

/**
 * E2E: THE DEMO ACCOUNT RESET (/reset)
 * ====================================
 *
 * There is no withdrawal on this venue and there never will be one: it holds no
 * custody, so a "withdrawal" could only delete a scoreboard and hand back a
 * receipt naming an address that received nothing. `/withdraw` is a redirect to
 * `/reset` (next.config.js), and the page renders
 * components/Wallet/ResetForm.tsx - a demo reset that sets the spot wallet
 * back to 1,000 USDC + 1,000 USD and zeroes everything else.
 *
 * WHAT THIS FILE USED TO SAY, AND WHY IT WAS REWRITTEN. It asserted a product
 * two rounds out of date and had been failing for both reasons:
 *
 *   - "10,000 demo USDC" everywhere. The grant is 1,000 USDC + 1,000 USD, and
 *     the confirm dialog no longer says the reset will cancel the user's
 *     resting orders - it says the opposite, because spotapi REFUSES a reset
 *     while anything is resting (a cancelled order's refund landing on top of
 *     the fixed balances a reset writes is how an account once went 10,000 ->
 *     48,039.52);
 *   - it ran SIGNED OUT, because /withdraw was not middleware-protected.
 *     /reset is now in `protectedRoutes`.
 *
 * The reset is NOT actually confirmed here. It is the one control in the
 * product that destroys state, and a spec that fires it leaves every other spec
 * racing a wiped account; the cancel path is exercised instead, which is what
 * proves the confirmation exists.
 */

test.describe('the reset page is behind a login', () => {
  test('a signed-out visitor is sent to /login', async ({ page }) => {
    await page.goto('/reset');
    await page.waitForURL(/\/login/);
    expect(page.url()).toContain('/login');
  });

  test('the old /withdraw URL still resolves, and is guarded too', async ({ page }) => {
    await page.goto('/withdraw');
    await page.waitForURL(/\/login/);
    expect(page.url()).toContain('/login');
  });
});

test.describe('Demo Account Reset Page', () => {
  let account: TestAccount;

  test.beforeAll(async () => {
    account = await registerAccount();
  });

  test.beforeEach(async ({ page }) => {
    await signIn(page, account);
    await page.goto('/reset', { waitUntil: 'domcontentloaded' });
    await expect(
      page.getByRole('heading', { name: 'Reset Demo Account' })
    ).toBeVisible({ timeout: 20000 });
  });

  test('shows the reset screen and the shortcut back to the faucet', async ({ page }) => {
    await expect(page.getByRole('button', { name: /claim funds/i })).toBeVisible();
  });

  test('shows the balance the reset would overwrite', async ({ page }) => {
    await expect(page.getByText('Current Spot Balance')).toBeVisible();
    await expect(page.getByText(/USDC$/).first()).toBeVisible();
  });

  test('explains what a reset does, in the grant the faucet actually pays', async ({
    page,
  }) => {
    await expect(
      page.getByText(/your spot wallet is set to 1,000 USDC \+ 1,000 USD/i)
    ).toBeVisible();
    await expect(page.getByText(/This cannot be undone/)).toBeVisible();
  });

  test('carries the paper-trading disclaimers', async ({ page }) => {
    const banner = page.locator('.paper_trading_banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/virtual funds only/i);
    await expect(
      page.getByText(/no real money is withdrawn\s*or moved/)
    ).toBeVisible();
  });

  test('asks for confirmation, tells the truth in it, and can be cancelled', async ({
    page,
  }) => {
    const resetButton = page.getByRole('button', { name: 'Reset Demo Account' }).last();
    await expect(page.getByTestId('reset-confirm-warning')).toHaveCount(0);

    await resetButton.click();

    const warning = page.getByTestId('reset-confirm-warning');
    await expect(warning).toBeVisible();
    // It must NOT promise to cancel the user's orders - it refuses instead.
    await expect(warning).toContainText(/1,000 USDC \+ 1,000 USD/);
    await expect(warning).toContainText(/refused/i);
    await expect(warning).not.toContainText(/cancel every open spot order/i);
    await expect(page.getByRole('button', { name: 'Confirm Reset' })).toBeVisible();

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('reset-confirm-warning')).toHaveCount(0);
  });

  test('renders no real-money withdrawal UI at all', async ({ page }) => {
    await expect(page.getByPlaceholder(/address/i)).toHaveCount(0);
    await expect(page.getByPlaceholder(/amount/i)).toHaveCount(0);
    await expect(page.getByText(/TRC20|ERC20|BEP20/)).toHaveCount(0);
    await expect(page.getByText(/network fee/i)).toHaveCount(0);
    await expect(
      page.locator('input[name="otp"], input[placeholder*="OTP"], input[placeholder*="2FA"]')
    ).toHaveCount(0);
  });
});

test.describe('withdrawal is gone from the product, not hidden in it', () => {
  let account: TestAccount;

  test.beforeAll(async () => {
    account = await registerAccount();
  });

  test('/history offers no withdrawal archive', async ({ page }) => {
    // The "Past Withdrawals" tab read spot/getWithdrawalHistory, a route that
    // was deleted - so it fetched a 404 and showed an empty archive of a
    // facility no account on this venue has ever used.
    await signIn(page, account);
    await page.goto('/history', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Demo Credits')).toBeVisible({ timeout: 20000 });
    await expect(page.getByText(/past withdrawals/i)).toHaveCount(0);
  });

  test('the mailed withdrawal-confirmation links do nothing at all', async ({ page }) => {
    // /verification/coinwithdraw and /verification/fiatWithdraw PATCHed
    // walletapi endpoints that no longer exist. Both were live URLs.
    const patched: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PATCH') patched.push(r.url());
    });

    for (const id of ['coinwithdraw', 'fiatWithdraw']) {
      await page.goto(`/verification/${id}?auth=whatever`, {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForTimeout(2000);
      await expect(page.getByText(/not one we recognise|Invalid Url/i)).toBeVisible();
    }

    expect(patched).toEqual([]);
  });
});
