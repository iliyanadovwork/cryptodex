import { test, expect } from '@playwright/test';

/**
 * THE LANDING PAGE ON A PHONE (CRITICAL)
 * ======================================
 *
 * Two defects, both measured in a 390px-wide Chromium against the running app:
 *
 *   1. THE PAGE SCROLLED SIDEWAYS. documentElement.scrollWidth was 639 against
 *      an innerWidth of 390, and every pixel of the excess was ornament -
 *      `.discover_img::before`, a 500x500 blurred glow at `left: 30%` with no
 *      right-hand constraint (117 + 500 = 617), plus AOS's initial 3D rotation
 *      on elements not yet scrolled into view. Nothing readable lived out
 *      there. What a reader got was a page that slides under the thumb on
 *      every slightly-off vertical swipe.
 *
 *   2. IT WEIGHED 20.19 MB, AND 19.77 MB OF THAT WAS ONE DECORATIVE VIDEO -
 *      a 20-second 1920x1080 60fps H.264 at 8.3 Mbit/s, with an audio track,
 *      played muted behind the headline. 98% of the first load of the first
 *      page anybody sees.
 *
 * Both are asserted here rather than only in the unit suite, because both are
 * facts about what a BROWSER does with the page: a file-size check cannot see a
 * layout overflow, and a CSS assertion cannot see what was actually fetched.
 *
 * The budget is a ceiling with room in it - it should fail on a 20 MB video
 * coming back, not on a re-encode that lands 40 KB heavier.
 */

const PHONE = { width: 390, height: 844 };

test.describe('the landing page on a 390px phone (CRITICAL)', () => {
  test('does not scroll sideways', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/', { waitUntil: 'load' });
    // AOS initialises on mount and the hero video starts; give the page the
    // moment in which the old overflow used to appear.
    await page.waitForTimeout(4000);

    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));

    // Measured before the fix: 639 vs 390.
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
  });

  test('does not pull megabytes of decoration before it can be read', async ({ page }) => {
    await page.setViewportSize(PHONE);

    let bytes = 0;
    const heavy: string[] = [];
    page.on('response', (r) => {
      const len = Number(r.headers()['content-length'] || 0);
      if (!len) return;
      bytes += len;
      if (len > 5 * 1024 * 1024) heavy.push(`${(len / 1048576).toFixed(2)}MB ${r.url()}`);
    });

    await page.goto('/', { waitUntil: 'load' });
    await page.waitForTimeout(6000);

    // Measured before the fix: 20.19 MB, of which 19.77 MB was the background
    // loop. The loop is now 4.53 MB - deliberately raised from 1.6 MB, which
    // was 670 kbit/s at 1080p and visibly broke up in the dark gradients. Both
    // ceilings here track __tests__/pages/landingWeight.test.ts (5 MB per file);
    // keep the three in step if the budget ever moves again.
    expect(heavy).toEqual([]);
    expect(bytes).toBeLessThan(9 * 1024 * 1024);
  });

  test('shows the hero immediately, not a black rectangle', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const video = page.locator('video').first();
    await expect(video).toHaveAttribute('poster', /cryptodexbg-poster/);
    // The headline is the point of the page and must not wait on the video.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });
});
