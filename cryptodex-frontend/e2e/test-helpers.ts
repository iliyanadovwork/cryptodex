import { Page } from '@playwright/test';

/**
 * E2E Test Helpers
 *
 * Common utilities for end-to-end testing of the crypto exchange.
 */

export const testCredentials = {
  email: `e2e-test-${Date.now()}@example.com`,
  password: 'TestSecurePassword123!',
  weakPassword: 'weak',
};

/**
 * Generates unique test credentials for each test run
 */
export function generateTestCredentials() {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 10000);
  return {
    email: `e2e-test-${timestamp}-${random}@example.com`,
    password: 'TestSecurePassword123!',
    firstName: 'Test',
    lastName: 'User',
  };
}

/**
 * Helper class for common page interactions
 */
export class ExchangePage {
  constructor(public page: Page) {}

  /**
   * Navigate to a specific page
   */
  async navigate(path: string) {
    await this.page.goto(path);
    await this.page.waitForLoadState('networkidle');
  }

  /**
   * Wait for page to be fully loaded
   */
  async waitForPageLoad() {
    await this.page.waitForLoadState('domcontentloaded');
    await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {
      // Continue if networkidle times out (some pages keep polling)
    });
  }

  /**
   * Fill an input field by label
   */
  async fillByLabel(label: string, value: string) {
    const input = this.page.getByLabel(label);
    await input.waitFor({ state: 'visible', timeout: 5000 });
    await input.fill(value);
  }

  /**
   * Fill an input field by placeholder
   */
  async fillByPlaceholder(placeholder: string, value: string) {
    const input = this.page.getByPlaceholder(placeholder);
    await input.waitFor({ state: 'visible', timeout: 5000 });
    await input.fill(value);
  }

  /**
   * Click a button by text
   */
  async clickButton(text: string) {
    const button = this.page.getByRole('button', { name: text });
    await button.waitFor({ state: 'visible', timeout: 5000 });
    await button.click();
  }

  /**
   * Wait for success message or toast
   */
  async waitForSuccess() {
    await this.page.waitForSelector('[class*="success"], [role="alert"]:has-text("success")', {
      timeout: 10000,
    }).catch(() => {
      // Check for common success indicators
    });
  }

  /**
   * Wait for error message
   */
  async waitForError() {
    await this.page.waitForSelector('[class*="error"], [class*="danger"], [role="alert"]', {
      timeout: 10000,
    });
  }

  /**
   * Check if element exists
   */
  async exists(selector: string): Promise<boolean> {
    return await this.page.locator(selector).count() > 0;
  }
}

/**
 * Auth helper for login/logout operations
 */
export class AuthHelper {
  constructor(public page: Page) {}

  /**
   * Navigate to login page
   */
  async goToLogin() {
    await this.page.goto('/login');
    await this.page.waitForLoadState('domcontentloaded');
  }

  /**
   * Navigate to register page
   */
  async goToRegister() {
    await this.page.goto('/register');
    await this.page.waitForLoadState('domcontentloaded');
  }

  /**
   * Fill and submit login form
   */
  async login(email: string, password: string) {
    await this.goToLogin();

    // Wait for email input
    await this.page.waitForSelector('input[type="email"], input[name="email"]', {
      timeout: 10000,
    });

    // Fill email
    const emailInput = this.page.locator('input[type="email"], input[name="email"]').first();
    await emailInput.fill(email);

    // Fill password
    const passwordInput = this.page.locator('input[type="password"]').first();
    await passwordInput.fill(password);

    // Click login button
    const loginButton = this.page.getByRole('button', { name: /login|sign in/i });
    await loginButton.click();

    // Wait for navigation or success indicator
    await this.page.waitForURL(/\//, { timeout: 15000 }).catch(() => {
      // Login might redirect to dashboard
    });
  }

  /**
   * Fill and submit registration form
   */
  async register(email: string, password: string, confirmPassword?: string) {
    await this.goToRegister();

    // Wait for form to load
    await this.page.waitForSelector('input[type="email"], input[name="email"]', {
      timeout: 10000,
    });

    // Fill email
    const emailInput = this.page.locator('input[type="email"], input[name="email"]').first();
    await emailInput.fill(email);

    // Fill password
    const passwordInputs = this.page.locator('input[type="password"]');
    await passwordInputs.nth(0).fill(password);

    // Fill confirm password if exists
    if (confirmPassword || (await passwordInputs.count()) > 1) {
      await passwordInputs.nth(1).fill(confirmPassword || password);
    }

    // Click register button
    const registerButton = this.page.getByRole('button', { name: /register|sign up|create account/i });
    await registerButton.click();

    // Wait for response
    await this.page.waitForTimeout(2000);
  }

  /**
   * Logout if logged in
   */
  async logout() {
    // Look for logout button or dropdown
    const logoutButton = this.page.getByRole('button', { name: /logout|sign out/i });
    const hasLogout = await logoutButton.count() > 0;

    if (hasLogout) {
      await logoutButton.click();
    }
  }

  /**
   * Check if user is authenticated
   */
  async isAuthenticated(): Promise<boolean> {
    // Check for common authenticated user indicators
    const indicators = [
      'a[href="/logout"]',
      'button:has-text("Logout")',
      '[data-testid="user-menu"]',
    ];

    for (const indicator of indicators) {
      if (await this.page.locator(indicator).count() > 0) {
        return true;
      }
    }

    return false;
  }
}
