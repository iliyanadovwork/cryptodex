/**
 * IS THIS CONTROL ACTUALLY VISIBLE?
 * =================================
 *
 * WHY A LIBRARY EXISTS FOR THIS
 * The "Cancel" button in every trade-page modal was `color: #070707` on
 * `background: #070707`. Not a subtle failure - the identical value on both
 * sides, a contrast ratio of exactly 1.00, a control that is present, focusable,
 * clickable and completely unseeable. It survived because nothing in the
 * codebase could state the invariant it broke: the two declarations live 600
 * lines apart in styles/common.module.css, one on `.primary_btn` and one on
 * `.custom_modal .modal_footer button label`, and neither reads as wrong on its
 * own.
 *
 * So the invariant is written down here as arithmetic, and
 * __tests__/styles/modalFooterContrast.test.ts holds the stylesheet to it by
 * reading the real declarations back out of the real file. A future edit that
 * repaints a footer label to its own button's background fails a test instead
 * of shipping an invisible button.
 *
 * WCAG 2.1 contrast, exactly as specified: sRGB channels linearised, relative
 * luminance, (L_lighter + 0.05) / (L_darker + 0.05). Nothing bespoke.
 */

/** WCAG 2.1 AA for normal-size text. Button labels here are 16px/500. */
export const MIN_CONTRAST_AA = 4.5;

/** WCAG 2.1 AA for large text (>=18.66px bold or >=24px). */
export const MIN_CONTRAST_AA_LARGE = 3;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * `#abc`, `#aabbcc`, `rgb(1, 2, 3)` and `rgba(1, 2, 3, 0.5)` -> channels.
 *
 * ALPHA IS DELIBERATELY IGNORED, NOT SUPPORTED. A translucent colour's real
 * contrast depends on what is behind it, which a string cannot say; returning a
 * confident number for `rgba(0,0,0,0.02)` would be a worse answer than none.
 * Callers that hand us a translucent colour get its opaque channels, and the
 * test that uses this only ever passes fully opaque declarations.
 *
 * Anything else - a named colour, a `var(...)` that was never resolved, an
 * empty string - returns null. Null means "cannot judge", and every caller
 * treats that as a reason to say nothing rather than to invent a verdict.
 */
export function parseColor(value: any): Rgb | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (text === "") return null;

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
  if (hex) {
    const digits = hex[1];
    if (digits.length <= 4) {
      return {
        r: parseInt(digits[0] + digits[0], 16),
        g: parseInt(digits[1] + digits[1], 16),
        b: parseInt(digits[2] + digits[2], 16),
      };
    }
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16),
    };
  }

  const fn = /^rgba?\(([^)]+)\)$/.exec(text);
  if (fn) {
    const parts = fn[1]
      .split(/[,/\s]+/)
      .map((p) => p.trim())
      .filter((p) => p !== "");
    if (parts.length < 3) return null;
    const channels = parts.slice(0, 3).map((p) => {
      // Percentages are legal in rgb(); resolve them rather than NaN out.
      if (p.endsWith("%")) {
        const pct = parseFloat(p);
        return Number.isFinite(pct) ? (pct / 100) * 255 : NaN;
      }
      return parseFloat(p);
    });
    if (channels.some((c) => !Number.isFinite(c))) return null;
    const [r, g, b] = channels.map((c) => Math.min(255, Math.max(0, c)));
    return { r, g, b };
  }

  return null;
}

/** WCAG relative luminance of an sRGB colour. */
export function relativeLuminance(color: Rgb): number {
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * channel(color.r) +
    0.7152 * channel(color.g) +
    0.0722 * channel(color.b)
  );
}

/**
 * WCAG contrast ratio between two colours, or null when either cannot be read.
 *
 * Symmetric by construction (the brighter of the two is always the numerator),
 * so a caller never has to know which argument is the foreground. 1 means the
 * two colours are indistinguishable, which is precisely the bug this exists to
 * catch; 21 is black on white.
 */
export function contrastRatio(a: any, b: any): number | null {
  const first = parseColor(a);
  const second = parseColor(b);
  if (!first || !second) return null;
  const la = relativeLuminance(first);
  const lb = relativeLuminance(second);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Whether `foreground` on `background` clears the bar.
 *
 * FALSE FOR UNREADABLE INPUT, and that direction is chosen on purpose: this
 * answers "may I be confident this is legible", and a colour pair we cannot
 * parse has not earned that confidence. A guard that passed on unknown input
 * would have passed on the very stylesheet that shipped the invisible button
 * had either declaration been written as `var(--btn_linear)`.
 */
export function meetsContrast(
  foreground: any,
  background: any,
  minimum: number = MIN_CONTRAST_AA
): boolean {
  const ratio = contrastRatio(foreground, background);
  if (ratio === null) return false;
  return ratio >= minimum;
}
