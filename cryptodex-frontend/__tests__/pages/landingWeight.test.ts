/**
 * THE LANDING PAGE'S WEIGHT IS A BUDGET, NOT AN ACCIDENT (CRITICAL)
 * ================================================================
 *
 * MEASURED in a 390px-wide Chromium against the running app: the home page
 * pulled 20.19 MB, and 19.77 MB of it - 98% - was one decorative background
 * video. Nobody chose that; a 20-second 1920x1080 60fps clip at 8.3 Mbit/s,
 * with an audio track it plays muted, was simply dropped into public/ and
 * pointed at. It is the first thing every visitor loads and it arrives before
 * anything they came for.
 *
 * It now ships as 1920x1080 30fps two-pass VBR at 1900 kbit/s, no audio,
 * faststart: 4.53 MB. An earlier pass squeezed it to 1.6 MB, which is 670
 * kbit/s at 1080p - far too little for this clip, whose dark blue gradients
 * banded and broke up visibly. The budget below was raised from 2 MB to 5 MB
 * deliberately, to buy that bitrate back.
 *
 * 5 MB is still a ceiling with a real reason: the failure this file guards
 * against is the 19.77 MB re-export, and 5 MB is four times under it.
 *
 * These assertions are about the FILES, because that is where the regression
 * would come back: someone re-exports the loop from a design tool and drops the
 * new one in. A browser-level check of the same fact lives in
 * e2e/landing-page.spec.ts.
 *
 * The budgets are ceilings with room in them, not descriptions of the current
 * bytes - a test that fails on a 2 KB re-encode is a test people delete.
 */

import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");
const PUBLIC_IMAGES = path.join(ROOT, "public/assets/images");
const MB = 1024 * 1024;

// One ceiling, used by both the named-file check and the public/ sweep, so the
// two can never drift apart and quietly disagree about what "too big" means.
const VIDEO_BUDGET = 5 * MB;

const sizeOf = (rel: string) => fs.statSync(path.join(PUBLIC_IMAGES, rel)).size;

describe("the landing page's background loop", () => {
  test("is a background, not a download - under 5 MB", () => {
    // It was 19.77 MB. A double-digit MB background is the same mistake again.
    expect(sizeOf("cryptodexbganimation.mp4")).toBeLessThan(VIDEO_BUDGET);
  });

  test("has a poster, so the hero is never a black rectangle while it loads", () => {
    expect(fs.existsSync(path.join(PUBLIC_IMAGES, "cryptodexbg-poster.jpg"))).toBe(
      true
    );
    expect(sizeOf("cryptodexbg-poster.jpg")).toBeLessThan(200 * 1024);
  });

  test("the page asks for the poster and does not eagerly preload the video", () => {
    const src = fs.readFileSync(path.join(ROOT, "pages/index.tsx"), "utf8");
    expect(src).toContain('poster="/assets/images/cryptodexbg-poster.jpg"');
    expect(src).toContain('preload="metadata"');
  });

  test("the unused light-theme copy is gone", () => {
    // 28.6 MB sitting in public/, referenced by nothing in the repository -
    // not served by the app, but downloadable by anyone who guessed the name
    // and part of every checkout and deploy.
    expect(
      fs.existsSync(path.join(PUBLIC_IMAGES, "cryptodexbganimationlight.mp4"))
    ).toBe(false);
  });

  test("no other video in public/ is larger than the budget either", () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.(mp4|webm|mov)$/i.test(entry.name)) out.push(full);
      }
      return out;
    };
    const oversize = walk(path.join(ROOT, "public"))
      .filter((f) => fs.statSync(f).size > VIDEO_BUDGET)
      .map((f) => `${path.relative(ROOT, f)} (${(fs.statSync(f).size / MB).toFixed(1)} MB)`);
    expect(oversize).toEqual([]);
  });
});

describe("nothing decorative may widen the page", () => {
  const globals = fs.readFileSync(path.join(ROOT, "styles/globals.css"), "utf8");
  const common = fs.readFileSync(
    path.join(ROOT, "styles/common.module.css"),
    "utf8"
  );

  test("the root clips horizontally rather than scrolling", () => {
    // `clip`, not `hidden`: `hidden` on the root turns the viewport into a
    // scroll container and breaks position: sticky everywhere.
    expect(globals).toMatch(/html,\s*\n?body\s*\{[^}]*overflow-x:\s*clip/);
    expect(globals).not.toMatch(/html,\s*\n?body\s*\{[^}]*overflow-x:\s*hidden/);
  });

  test("the section whose glow caused it keeps the glow inside itself", () => {
    // .discover_img::before is 500x500 at left: 30% with no right-hand
    // constraint - 617px of ornament on a 390px screen, which is exactly the
    // 639px document scrollWidth that was measured.
    const block = common.slice(
      common.indexOf(".discover_home {"),
      common.indexOf(".discover_home .h2tag")
    );
    expect(block).toMatch(/overflow:\s*hidden/);
  });
});
