/**
 * THE STYLESHEET IS HELD TO THE INVARIANT IT BROKE.
 *
 * These read the REAL styles/common.module.css and styles/globals.css off disk
 * and recompute the number that was measured in Chrome:
 *
 *   Cancel  label rgb(7,7,7) on button rgb(7,7,7)  -> 1.00
 *
 * Jest maps `*.module.css` to identity-obj-proxy, so a rendering test cannot
 * see a single colour; the file itself is the only place the truth lives.
 *
 * WHAT THIS IS AND IS NOT. It is NOT a cascade engine. The candidate selectors
 * for each element are listed by hand, most-specific last, and the last one
 * that declares the property wins. That is an APPROXIMATION of the browser:
 * global stylesheets, inherited colours and `!important` from rules not in the
 * list are all outside it, and the live measurement after the fix bears that
 * out - Chrome resolves the Cancel label to white (20.14:1) where this model
 * says #1d94ff (6.46:1). Both clear AA, and the assertion is the THRESHOLD, not
 * the exact colour, for exactly that reason.
 *
 * What it does hold is the property that failed: no declaration in this file
 * may paint a modal-footer label the colour of the button underneath it. That
 * is a statement about the declarations, and the declarations are what shipped
 * the invisible button. The browser measurement is in the report.
 */
import fs from "fs";
import path from "path";
import {
  contrastRatio,
  MIN_CONTRAST_AA,
  parseColor,
} from "@/lib/contrast";

const STYLES = path.join(process.cwd(), "styles");
const COMMON = fs.readFileSync(path.join(STYLES, "common.module.css"), "utf8");
const GLOBALS = fs.readFileSync(path.join(STYLES, "globals.css"), "utf8");

/** Strip comments so a commented-out rule is never mistaken for a live one. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

const COMMON_LIVE = stripComments(COMMON);
const GLOBALS_LIVE = stripComments(GLOBALS);

/** Every `--name: value` declared anywhere in globals.css, first wins. */
function customProperties(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(--[\w-]+)\s*:\s*([^;{}]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const name = m[1];
    if (!(name in out)) out[name] = m[2].trim();
  }
  return out;
}

const VARS = customProperties(GLOBALS_LIVE);

/** Resolve one level of `var(--x)`; enough for this stylesheet's tokens. */
function resolveVar(value: string | null): string | null {
  if (value === null) return null;
  const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(value.trim());
  if (!m) return value.trim();
  const declared = VARS[m[1]];
  if (declared) return declared.trim();
  return m[2] ? m[2].trim() : null;
}

/**
 * The value of `prop` in the rule whose selector list is exactly `selector`.
 * `!important` and any trailing whitespace are dropped; null when the rule or
 * the property is absent.
 */
function declaration(css: string, selector: string, prop: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m");
  const rule = re.exec(css);
  if (!rule) return null;
  const decl = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "i").exec(
    rule[2]
  );
  if (!decl) return null;
  return decl[1].replace(/!important/i, "").trim();
}

/** Last candidate selector that declares `prop`, mirroring the cascade. */
function effective(
  css: string,
  selectors: string[],
  prop: string
): string | null {
  let winner: string | null = null;
  for (const selector of selectors) {
    const value = declaration(css, selector, prop);
    if (value !== null) winner = value;
  }
  return resolveVar(winner);
}

/**
 * Every modal footer in the app renders the same two buttons: a plain
 * `.primary_btn` (Cancel / back out) and a `.primary_btn.dark` (Confirm).
 * Both are checked, because "fix the invisible one by breaking the other" is
 * exactly the over-correction this file has to refuse.
 */
const FOOTER_CANCEL_LABEL = [
  // The button owns the colour now and the label inherits it, so the button is
  // the first candidate; a label that re-declares a colour still wins, which is
  // the case this list exists to catch.
  ".primary_btn",
  ".primary_btn label",
  ".custom_modal .modal_footer button label",
];
const FOOTER_CANCEL_BUTTON = [".primary_btn"];

const FOOTER_CONFIRM_LABEL = [
  ".primary_btn",
  ".dark",
  ".primary_btn label",
  ".custom_modal .modal_footer button label",
  ".dark label",
  ".custom_modal .modal_footer button.dark label",
];
const FOOTER_CONFIRM_BUTTON = [".primary_btn", ".dark"];

const LOGIN_PLAIN_LABEL = [
  // The button owns the colour; the label inherits unless it re-declares one.
  ".primary_btn",
  ".primary_btn label",
  ".login_tabs .primary_btn label",
];
const LOGIN_DARK_LABEL = [
  ".primary_btn",
  ".dark",
  ".primary_btn label",
  ".login_tabs .primary_btn label",
  ".dark label",
  ".login_tabs .primary_btn.dark label",
];

/**
 * WHAT AN OUTLINED BUTTON'S LABEL SITS ON.
 *
 * `.primary_btn` paints no background of its own any more - the outlined
 * variant is `background: transparent`, so there is no button colour for a
 * label to disappear into and `contrastRatio(fg, "transparent")` is null rather
 * than a number. The legibility question does not go away though: the label now
 * sits on whatever surface is BEHIND the button, so that is what it is judged
 * against. --btn_linear (#070707) is the darkest surface the app paints, so a
 * label that clears AA on it clears AA everywhere in this theme.
 */
const SURFACE_BEHIND = resolveVar("var(--btn_linear)");
const onSurface = (bg: string | null): string | null =>
  bg === null || bg.trim() === "transparent" ? SURFACE_BEHIND : bg;

describe("modal footer button contrast (styles/common.module.css)", () => {
  it("resolves the tokens it is about to judge", () => {
    // If this fails the rest of the file is judging nulls, not colours.
    expect(parseColor(resolveVar("var(--btn_linear)"))).not.toBeNull();
    expect(parseColor(resolveVar("var(--btn_hover-bg)"))).not.toBeNull();
    expect(parseColor(resolveVar("var(--text_black)"))).not.toBeNull();
  });

  it("Cancel's label is legible on Cancel's own background", () => {
    const fg = effective(COMMON_LIVE, FOOTER_CANCEL_LABEL, "color");
    const bg = onSurface(effective(COMMON_LIVE, FOOTER_CANCEL_BUTTON, "background"));
    const ratio = contrastRatio(fg, bg);
    expect(ratio).not.toBeNull();
    expect(ratio as number).toBeGreaterThanOrEqual(MIN_CONTRAST_AA);
  });

  it("Confirm's label is legible on Confirm's own background", () => {
    const fg = effective(COMMON_LIVE, FOOTER_CONFIRM_LABEL, "color");
    const bg = onSurface(effective(COMMON_LIVE, FOOTER_CONFIRM_BUTTON, "background"));
    const ratio = contrastRatio(fg, bg);
    expect(ratio).not.toBeNull();
    expect(ratio as number).toBeGreaterThanOrEqual(MIN_CONTRAST_AA);
  });

  it("does not paint a footer label the colour of the button under it", () => {
    // The specific shape of the bug, stated as itself: whatever the two
    // declarations end up being, they may not be the SAME colour.
    const fg = effective(COMMON_LIVE, FOOTER_CANCEL_LABEL, "color");
    const bg = onSurface(effective(COMMON_LIVE, FOOTER_CANCEL_BUTTON, "background"));
    expect(contrastRatio(fg, bg)).not.toBe(1);
  });

  it("gives the two footer buttons distinguishable backgrounds", () => {
    // Cancel and Confirm are told apart by background alone (both are 16px/500
    // labels in an identical box). Collapsing them would also put Confirm's
    // black label onto Cancel's black background, which is the shipped bug
    // again wearing the other button's name.
    const plain = onSurface(effective(COMMON_LIVE, FOOTER_CANCEL_BUTTON, "background"));
    const dark = onSurface(effective(COMMON_LIVE, FOOTER_CONFIRM_BUTTON, "background"));
    const ratio = contrastRatio(plain, dark);
    expect(ratio).not.toBeNull();
    expect(ratio as number).toBeGreaterThan(1);
  });

  it("auth-form buttons are legible in both variants", () => {
    const bgPlain = onSurface(effective(COMMON_LIVE, [".primary_btn"], "background"));
    const bgDark = onSurface(effective(COMMON_LIVE, [".primary_btn", ".dark"], "background"));

    const plain = contrastRatio(
      effective(COMMON_LIVE, LOGIN_PLAIN_LABEL, "color"),
      bgPlain
    );
    const dark = contrastRatio(
      effective(COMMON_LIVE, LOGIN_DARK_LABEL, "color"),
      bgDark
    );

    expect(plain).not.toBeNull();
    expect(plain as number).toBeGreaterThanOrEqual(MIN_CONTRAST_AA);
    expect(dark).not.toBeNull();
    expect(dark as number).toBeGreaterThanOrEqual(MIN_CONTRAST_AA);
  });
});
