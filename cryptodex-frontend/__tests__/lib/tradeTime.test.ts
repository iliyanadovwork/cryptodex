/**
 * The trade tape printed "22:47:0". These hold the boundaries that produced it.
 *
 * Dates are constructed with `new Date(y, m, d, h, mi, s)` — the LOCAL-time
 * constructor — because tradeTime formats in local time and an ISO string with
 * a Z would make every expectation depend on the machine's timezone.
 */
import { tradeTime } from "@/lib/tradeTime";

const at = (h: number, m: number, s: number) =>
  new Date(2026, 7, 6, h, m, s);

describe("tradeTime — zero padding", () => {
  it("pads seconds below ten (the measured '22:47:0' bug)", () => {
    expect(tradeTime(at(22, 47, 0))).toBe("22:47:00");
    expect(tradeTime(at(22, 47, 5))).toBe("22:47:05");
    expect(tradeTime(at(22, 47, 9))).toBe("22:47:09");
  });

  it("pads minutes below ten", () => {
    expect(tradeTime(at(22, 0, 30))).toBe("22:00:30");
    expect(tradeTime(at(22, 9, 30))).toBe("22:09:30");
  });

  it("pads hours below ten", () => {
    expect(tradeTime(at(0, 30, 30))).toBe("00:30:30");
    expect(tradeTime(at(9, 30, 30))).toBe("09:30:30");
  });

  it("pads all three at once — midnight is 00:00:00, never 0:0:0", () => {
    expect(tradeTime(at(0, 0, 0))).toBe("00:00:00");
  });

  it("does NOT pad values of ten or more, and never truncates them", () => {
    expect(tradeTime(at(10, 10, 10))).toBe("10:10:10");
    expect(tradeTime(at(23, 59, 59))).toBe("23:59:59");
  });

  it("every second of a full hour renders exactly 8 characters", () => {
    for (let m = 0; m < 60; m++) {
      for (const s of [0, 5, 9, 10, 59]) {
        const out = tradeTime(at(7, m, s));
        expect(out).toHaveLength(8);
        expect(out).toMatch(/^\d{2}:\d{2}:\d{2}$/);
      }
    }
  });
});

describe("tradeTime — unreadable input is blank, not NaN", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty string", ""],
    ["nonsense string", "not-a-date"],
    ["NaN", NaN],
    ["an object", {}],
    ["an Invalid Date instance", new Date("nope")],
  ])("%s renders as an empty cell", (_label, input) => {
    expect(tradeTime(input as any)).toBe("");
  });

  it("never renders the string NaN, which is what padStart alone produced", () => {
    // String(NaN).padStart(2,"0") === "NaN" — padding does not save this case,
    // so a caller that only copied the padding fix would still print NaN:NaN:NaN.
    for (const bad of [undefined, null, "not-a-date", new Date("nope")]) {
      expect(tradeTime(bad as any)).not.toContain("NaN");
    }
  });
});

describe("tradeTime — accepted input shapes", () => {
  it("accepts a Date instance", () => {
    expect(tradeTime(at(1, 2, 3))).toBe("01:02:03");
  });

  it("accepts an epoch number", () => {
    const d = at(4, 5, 6);
    expect(tradeTime(d.getTime())).toBe("04:05:06");
  });

  it("accepts the ISO string the trade feed actually sends", () => {
    const d = at(13, 4, 7);
    // toISOString is UTC; parsing it back yields the same instant, and
    // formatting is local on both sides, so this round-trips regardless of TZ.
    expect(tradeTime(d.toISOString())).toBe("13:04:07");
  });

  it("treats epoch 0 as a real instant, not as missing", () => {
    // isEmpty()-style helpers call 0 empty and answer "". A trade at epoch 0 is
    // a valid instant and must still format.
    expect(tradeTime(new Date(1970, 0, 1, 0, 0, 0))).toBe("00:00:00");
    expect(tradeTime(0)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("does not mutate a Date it is given", () => {
    const d = at(8, 8, 8);
    const before = d.getTime();
    tradeTime(d);
    expect(d.getTime()).toBe(before);
  });
});
