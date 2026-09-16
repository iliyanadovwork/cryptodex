import {
  contrastRatio,
  meetsContrast,
  parseColor,
  relativeLuminance,
  MIN_CONTRAST_AA,
} from "@/lib/contrast";

describe("parseColor", () => {
  it("reads 6-digit hex", () => {
    expect(parseColor("#070707")).toEqual({ r: 7, g: 7, b: 7 });
    expect(parseColor("#1D94FF")).toEqual({ r: 29, g: 148, b: 255 });
  });

  it("reads 3-digit hex by doubling each digit, not by padding", () => {
    // #f00 is ff0000, not f00000. A padding implementation would say r:240.
    expect(parseColor("#f00")).toEqual({ r: 255, g: 0, b: 0 });
    expect(parseColor("#abc")).toEqual({ r: 170, g: 187, b: 204 });
  });

  it("reads rgb() and rgba(), ignoring alpha", () => {
    expect(parseColor("rgb(7, 7, 7)")).toEqual({ r: 7, g: 7, b: 7 });
    expect(parseColor("rgba(29, 148, 255, 0.5)")).toEqual({
      r: 29,
      g: 148,
      b: 255,
    });
    expect(parseColor("rgb(29 148 255 / 50%)")).toEqual({
      r: 29,
      g: 148,
      b: 255,
    });
  });

  it("resolves percentage channels", () => {
    expect(parseColor("rgb(100%, 0%, 0%)")).toEqual({ r: 255, g: 0, b: 0 });
  });

  it("clamps out-of-range channels rather than producing a fake luminance", () => {
    expect(parseColor("rgb(300, -20, 10)")).toEqual({ r: 255, g: 0, b: 10 });
  });

  it("returns null for anything it cannot read", () => {
    expect(parseColor("var(--btn_linear)")).toBeNull();
    expect(parseColor("transparent")).toBeNull();
    expect(parseColor("#12345")).toBeNull();
    expect(parseColor("rgb(1, 2)")).toBeNull();
    expect(parseColor("")).toBeNull();
    expect(parseColor("   ")).toBeNull();
    expect(parseColor(null)).toBeNull();
    expect(parseColor(undefined)).toBeNull();
    expect(parseColor(0x070707 as any)).toBeNull();
  });
});

describe("relativeLuminance", () => {
  it("anchors at the two ends of the sRGB range", () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 10);
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 10);
  });

  it("applies the linear segment below the 0.03928 knee", () => {
    // r=8 -> s=0.03137, which is BELOW the knee, so s/12.92 and not the power
    // curve. The power curve would give ~0.00242 here instead of ~0.00243.
    const low = relativeLuminance({ r: 8, g: 8, b: 8 });
    const s = 8 / 255;
    expect(low).toBeCloseTo(s / 12.92, 12);
  });

  it("weights green far above blue", () => {
    const green = relativeLuminance({ r: 0, g: 255, b: 0 });
    const blue = relativeLuminance({ r: 0, g: 0, b: 255 });
    expect(green).toBeGreaterThan(blue * 5);
  });
});

describe("contrastRatio", () => {
  it("is 21 for black on white", () => {
    expect(contrastRatio("#000000", "#ffffff") as number).toBeCloseTo(21, 6);
  });

  it("is exactly 1 for a colour on itself — the shipped bug", () => {
    expect(contrastRatio("#070707", "#070707")).toBe(1);
    expect(contrastRatio("rgb(7, 7, 7)", "#070707")).toBe(1);
  });

  it("is symmetric", () => {
    const a = contrastRatio("#1d94ff", "#070707");
    const b = contrastRatio("#070707", "#1d94ff");
    expect(a).toBe(b);
  });

  it("scores the real pair the fix installs above AA", () => {
    // #1d94ff (.primary_btn label) on #070707 (--btn_linear).
    const ratio = contrastRatio("#1d94ff", "#070707") as number;
    expect(ratio).toBeGreaterThan(6.4);
    expect(ratio).toBeLessThan(6.5);
  });

  it("scores the Confirm pair, which the fix must not disturb", () => {
    // #060606 (--text_black) on #1d94ff (--btn_hover-bg).
    const ratio = contrastRatio("#060606", "#1d94ff") as number;
    expect(ratio).toBeGreaterThan(6.4);
    expect(ratio).toBeLessThan(6.6);
  });

  it("returns null when either side cannot be read", () => {
    expect(contrastRatio("var(--nope)", "#000")).toBeNull();
    expect(contrastRatio("#000", "var(--nope)")).toBeNull();
    expect(contrastRatio(null, undefined)).toBeNull();
  });
});

describe("meetsContrast", () => {
  it("passes a legible pair and fails an invisible one", () => {
    expect(meetsContrast("#1d94ff", "#070707")).toBe(true);
    expect(meetsContrast("#070707", "#070707")).toBe(false);
  });

  it("is inclusive at the threshold, not exclusive", () => {
    // Contrived pair sitting a hair above and below 4.5 either way.
    const ratio = contrastRatio("#767676", "#ffffff") as number;
    expect(ratio).toBeGreaterThanOrEqual(MIN_CONTRAST_AA);
    expect(meetsContrast("#767676", "#ffffff", ratio)).toBe(true);
    expect(meetsContrast("#767676", "#ffffff", ratio + 1e-9)).toBe(false);
  });

  it("honours a caller-supplied minimum", () => {
    // ~3.1:1 clears the large-text bar and fails the normal-text one.
    const fg = "#8a8a8a";
    const bg = "#ffffff";
    const ratio = contrastRatio(fg, bg) as number;
    expect(ratio).toBeGreaterThan(3);
    expect(ratio).toBeLessThan(4.5);
    expect(meetsContrast(fg, bg, 3)).toBe(true);
    expect(meetsContrast(fg, bg, 4.5)).toBe(false);
  });

  it("FAILS on unreadable input rather than passing it through", () => {
    // The direction matters: a guard that returned true here would have let
    // the invisible button ship the moment a colour was written as a var().
    expect(meetsContrast("var(--btn_linear)", "#ffffff")).toBe(false);
    expect(meetsContrast("#000000", "transparent")).toBe(false);
  });
});
