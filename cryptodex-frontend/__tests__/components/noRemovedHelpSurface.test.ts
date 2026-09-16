/**
 * THE HELP, CMS AND PHONE SURFACES ARE GONE, AND HAVE TO STAY GONE.
 * ================================================================
 *
 * WHAT WAS REMOVED FROM THE FRONTEND, AND WHAT IT CALLED
 * -----------------------------------------------------
 * Each of these went because the endpoint behind it was withdrawn from userapi
 * in the same round. A client left pointing at a deleted route does not fail
 * at build time - it fails at the moment a user clicks something, which is the
 * worst possible place to find out.
 *
 *   pages/support-ticket.tsx          user/support (GET/POST/PUT/PATCH),
 *   components/SupportTicket/*        user/getSupportCategory
 *   lib/supportCategoryLabel.ts
 *
 *   pages/faq.tsx                     user/faq
 *   pages/contactus.tsx               user/addContactus
 *   components/contactus/*
 *
 *   services/common.service.ts        user/faq, user/cms/:id,
 *                                     user/home-cms/:id, user/cmcContent/:id,
 *                                     user/newsLetter/subscribe, user/slider
 *                                     - the whole CMS/newsletter/slider client.
 *                                     Its ONLY live caller outside the deleted
 *                                     pages was the footer's subscribe box.
 *
 *   components/security/BindMobile    user/phoneChange, user/sendOTP roleType 2
 *   components/Register/MoblieForm    registration by phone
 *   components/Login/MobileForm       sign-in by phone
 *   components/ForgotPassword/…       recovery by phone
 *   components/Deactive/MobileForm
 *
 *   components/security/BindEmail     user/emailChange - see R4 below
 *   components/security/AssetPassword user/asset-password, already unmounted
 *
 *   lib/cryptodexFee.ts                 the pay-fees-in-CRYPTODEX toggle's guard,
 *                                     with user/setting/updateCryptodexFee
 *
 * NOT REMOVED, and the tests below say so explicitly because the two are one
 * grep apart: **notifications** (user/notificationHistory,
 * user/readNotification - pages/notification.tsx) and the **e-mail one-time
 * code** (user/sendOTP with roleType 1, which change-password cannot work
 * without). The announcements broadcast that shared the notification page
 * went; the journal did not.
 *
 * `user/verifyOtp` and `auth/verifyOtp` HAVE gone, and their clients with them.
 * Neither had a caller: change password posts its code straight to
 * user/changePassword, which verifies it itself with `optVerification(2, ...)`,
 * and the login screen's OTP box submits back through auth/login.
 *
 * WHY A SOURCE-LEVEL GUARD
 * ------------------------
 * A render test can only speak for a component that still exists. What has to
 * hold now is a property of the whole tree: nothing IMPORTS a deleted module,
 * no surviving screen offers a route into a page that is not there, and no
 * client remains for a route that was withdrawn. So the tree is what is read.
 */

import fs from "fs";
import path from "path";

const root = process.cwd();

/** Every source file under the app's own directories. */
const sourceFiles = (): string[] => {
  const dirs = [
    "components",
    "pages",
    "lib",
    "store",
    "services",
    "hooks",
    "utils",
    "config",
  ];
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // The TradingView charting library is a vendored third-party bundle.
        if (entry.name === "ChartLib" || entry.name === "charting_library") continue;
        walk(full);
        continue;
      }
      if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) out.push(full);
    }
  };
  dirs.forEach((d) => walk(path.join(root, d)));
  return out;
};

const read = (file: string) => fs.readFileSync(file, "utf8");

/** Source with comments stripped: prose about the removal is not the removal. */
const code = (file: string) =>
  read(file)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

const exists = (rel: string) => fs.existsSync(path.join(root, rel));

describe("R1 the deleted files are actually deleted", () => {
  it.each([
    "pages/support-ticket.tsx",
    "pages/faq.tsx",
    "pages/contactus.tsx",
    "components/SupportTicket",
    "components/contactus",
    "components/security/BindMobile.tsx",
    "components/security/BindEmail.tsx",
    "components/security/AssetPassword.tsx",
    "components/Register/MoblieForm.tsx",
    "components/Login/MobileForm.tsx",
    "components/ForgotPassword/MobileForm.tsx",
    "components/Deactive/MobileForm.tsx",
    "lib/supportCategoryLabel.ts",
    "lib/cryptodexFee.ts",
    "services/common.service.ts",
    // Went with the footer: a paper venue that pays nothing out has no terms
    // to state, and the footer was the only route into either page.
    "components/footer.tsx",
    "pages/terms.tsx",
    "pages/privacy-policy.tsx",
    // Listed sign-ins and account changes: "Login success", repeatedly. The
    // trading record it explicitly disclaimed lives on /history.
    "pages/notification.tsx",
  ])("%s is gone", (rel) => {
    expect([rel, exists(rel)]).toEqual([rel, false]);
  });
});

describe("R2 nothing that survives imports one of them", () => {
  // A stale import of a deleted module is a build failure, and the module
  // graph is the only place that can say there is not one.
  const offendersFor = (pattern: RegExp) =>
    sourceFiles()
      .filter((f) => pattern.test(code(f)))
      .map((f) => path.relative(root, f));

  it.each([
    ["SupportTicket", /from\s+["'][^"']*SupportTicket/],
    ["contactus components", /from\s+["'][^"']*\/contactus\//],
    ["BindMobile", /from\s+["'][^"']*BindMobile/],
    ["BindEmail", /from\s+["'][^"']*BindEmail/],
    ["AssetPassword", /from\s+["'][^"']*AssetPassword/],
    ["MoblieForm / MobileForm", /from\s+["'][^"']*Mob(l)?ile?Form/],
    ["lib/supportCategoryLabel", /from\s+["'][^"']*supportCategoryLabel/],
    ["lib/cryptodexFee", /from\s+["'][^"']*cryptodexFee/],
    ["services/common.service", /from\s+["'][^"']*common\.service/],
    ["components/footer", /from\s+["'][^"']*\/footer["']/],
  ])("no surviving file imports %s", (_label, pattern) => {
    expect(offendersFor(pattern as RegExp)).toEqual([]);
  });
});

describe("R3 no client remains for a withdrawn route", () => {
  const allSource = () => sourceFiles().map((f) => code(f)).join("\n");

  it.each([
    "user/support",
    "user/getSupportCategory",
    "user/announcement",
    "user/faq",
    "user/addContactus",
    "user/newsLetter/subscribe",
    "user/slider",
    "user/getbranddetails",
    "user/home-cms",
    "user/cmcContent",
    "user/phoneChange",
    "user/setting/updateCryptodexFee",
    "user/verifyOtp",
    "auth/verifyOtp",
    "auth/cms",
  ])("nothing calls %s", (url) => {
    expect([url, allSource().includes(url)]).toEqual([url, false]);
  });

  it("nothing calls user/cms/:identifier either", () => {
    // Spelled apart from the list above because `user/cmcContent` would match
    // a naive `user/cms` substring test in the other direction.
    expect(allSource()).not.toMatch(/["'`][^"'`]*user\/cms\//);
  });
});

describe("R4 the surfaces that were KEPT are still wired", () => {
  const services = read(path.join(root, "services/User/UserServices.js"));

  /*
   * Two tests here pinned the notification page as a KEPT surface: that its two
   * clients were still wired, and that it no longer imported the announcements
   * client it once shared a screen with. The page is now deleted itself - it
   * listed sign-ins and account changes and nothing else - so "kept" is the
   * wrong section for it. R1 and R5 below cover its removal instead.
   *
   * The distinction the file header draws still matters and is NOT affected:
   * `user/sendOTP` is the e-mail one-time code, a different surface that a
   * grep for "notification" must not sweep up. The test below holds that.
   */

  it("the e-mail one-time code survived the removal of the phone one", () => {
    // change-password in userapi cannot complete without this. Removing
    // sendOTP wholesale as "the phone OTP" would take a kept feature with it,
    // so this asserts the client is still here to notice.
    expect(services).toContain("user/sendOTP");
    expect(services).toContain("apiEmailOTPRequest");
  });

  it("change password is the only thing that asks for a code, and it asks by e-mail", () => {
    const modal = code(path.join(root, "components/security/ChangePassword.tsx"));
    expect(modal).toContain("apiEmailOTPRequest");
    // roleType 1 is requestOTP's e-mail arm; roleType 2 was the SMS sender.
    expect(modal).toMatch(/roleType:\s*1/);
    expect(modal).not.toMatch(/roleType:\s*2/);
    expect(modal).not.toContain("apiSendOTP");
  });

  it("the plain maker/taker fees were removed too, in their own right", () => {
    // This asserted the opposite: that removing the pay-in-CRYPTODEX option left
    // the ordinary schedule intact. It did - and every fee was withdrawn from the
    // platform afterwards, as a separate change. The ticket now quotes nothing,
    // and spotapi charges nothing (lib/liquidityRole.feeRateFor returns 0).
    // code(), not read(): this very test's note names the fields it forbids,
    // and a comment mentioning them is not the ticket quoting them.
    const src = code(path.join(root, "components/spot/OrderForm.tsx"));
    expect(src).not.toContain("taker_fees");
    expect(src).not.toContain("maker_rebate");
  });
});

describe("R5 no surviving screen offers a route into a deleted page", () => {
  // Naming two files and asking whether THEY link to a deleted route is worth
  // little: the file that actually carried these links was the footer, and it
  // is deleted, so the check would pass on the two survivors no matter what a
  // third file did. Ask the whole tree instead.
  it.each([
    "/support-ticket",
    "/contactus",
    "/faq",
    "/terms",
    "/privacy-policy",
    "/notification",
  ])("no surviving screen links to %s", (route) => {
    const offenders = sourceFiles()
      .filter((f) => new RegExp(`href=["'\`]${route}["'\`]`).test(code(f)))
      .map((f) => path.relative(root, f));
    expect([route, offenders]).toEqual([route, []]);
  });

  it("the six deleted URLs are redirected rather than 404ed", () => {
    // All five were reachable from the product for its whole life - /faq,
    // /contactus, /terms and /privacy-policy from the footer of every page -
    // so they are in histories. The footer went too, which is why /terms and
    // /privacy-policy joined the list.
    // `code`, not `read`: this file's own comment block names /terms and
    // /privacy-policy in prose, and a commented-out redirect entry must not be
    // able to satisfy a check that the redirect exists.
    const config = code(path.join(root, "next.config.js"));
    for (const source of [
      "/faq",
      "/contactus",
      "/support-ticket",
      "/terms",
      "/privacy-policy",
      "/notification",
    ]) {
      expect([source, config.includes(`source: "${source}"`)]).toEqual([
        source,
        true,
      ]);
    }
  });
});

describe("R7 no screen offers a currency this venue does not list", () => {
  // SOL and ETH went with their markets; USDC went with the flat ledger built
  // for it. Each time, prose outlived the thing it described - the reset page
  // went on promising to zero "any BTC, ETH or SOL" months after ETH and SOL
  // stopped existing, which is a promise about balances a user cannot hold.
  //
  // Comments are stripped: a note explaining why a currency was removed is the
  // opposite of the defect. This is about what reaches the screen.
  // lib/coinImage.ts is exempt and stays that way. It maps a ticker to an icon
  // filename and lists BNB, XRP, ADA, DOGE, MATIC and others this venue has
  // never listed - it is a lookup table, not a claim about what you can hold,
  // and singling out three of its rows would be arbitrary.
  const EXEMPT = ["lib/coinImage.ts"];

  it.each(["ETH", "SOL", "USDC"])("no rendered copy names %s", (coin) => {
    const offenders = sourceFiles()
      .filter((f) => !EXEMPT.some((e) => f.endsWith(e)))
      .filter((f) => {
        const src = code(f);
        // Word-boundary match, so USDT-style tickers and words like "SOLD"
        // do not trip it.
        return new RegExp(`\\b${coin}\\b`).test(src);
      })
      .map((f) => path.relative(root, f));
    expect([coin, offenders]).toEqual([coin, []]);
  });
});

describe("R8 the venue links no social account", () => {
  // The navbar carried an X icon and a Telegram icon pointing at
  // x.com/cryptodex and t.me/cryptodex - accounts that do not exist. A
  // config/siteConfig.js sat behind them holding six more placeholder links,
  // read by nothing, whose TWITTER_LINK was "https://google.com/" and whose
  // TELEGRAM_LINK was "https://www.telegram.com/" - not Telegram's domain.
  //
  // A dead link to a profile nobody owns is worse than no link: it invites a
  // click and answers with someone else's page, or a 404.
  const SOCIAL = /href=["']https?:\/\/(?:www\.)?(?:x\.com|twitter\.com|t\.me|telegram\.[a-z]+|facebook\.com|linkedin\.com|youtube\.com|instagram\.com)/;

  it("no rendered source links a social profile", () => {
    const offenders = sourceFiles()
      .filter((f) => SOCIAL.test(code(f)))
      .map((f) => path.relative(root, f));
    expect(offenders).toEqual([]);
  });

  it("the placeholder link config is gone, not merely unused", () => {
    expect(exists("config/siteConfig.js")).toBe(false);
  });
});

describe("R6 the phone is gone from the account surface entirely", () => {
  it("no screen renders a phone number field", () => {
    for (const file of ["components/navbar.tsx", "pages/security.tsx"]) {
      const src = code(path.join(root, file));
      expect([file, /phoneNo/.test(src)]).toEqual([file, false]);
      expect([file, /phoneStatus/.test(src)]).toEqual([file, false]);
    }
  });
});
