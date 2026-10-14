import { describe, expect, it } from "vitest";
import kat from "./data/cvt-kat.json" with { type: "json" };
import { buildTiming, calcCvt, EdidEncodeError, parseRefresh } from "../src/index.ts";

describe("CVT known answers from edid-decode", () => {
  for (const r of kat.rows) {
    it(`${r.w}x${r.h}@${r.fps} rb=${r.rb}`, () => {
      const c = calcCvt(r.w, r.h, r.fps, r.rb as 0 | 1 | 2);
      expect(c.clockKHz).toBe(r.clockKHz);
      expect(c.porches).toEqual({
        hFrontPorch: r.hFrontPorch, hSync: r.hSync, hBackPorch: r.hBackPorch,
        vFrontPorch: r.vFrontPorch, vSync: r.vSync, vBackPorch: r.vBackPorch,
      });
      const built = buildTiming({ hActive: r.w, vActive: r.h, refresh: String(r.fps), formula: r.rb === 0 ? "cvt" : r.rb === 1 ? "cvt-rb" : "cvt-rb2" });
      expect([built.timing.hSyncPositive, built.timing.vSyncPositive]).toEqual([r.hSyncPositive, r.vSyncPositive]);
    });
  }
});

describe("parseRefresh", () => {
  it.each([
    ["50", 50, 1],
    ["59.94", 2997, 50],
    ["60000/1001", 60000, 1001],
    ["23.976", 2997, 125],
  ])("%s", (s, num, den) => {
    expect(parseRefresh(s)).toEqual({ num, den });
  });

  it.each(["", "abc", "-50", "0", "1/0", "50Hz"])("refuses %j", (s) => {
    expect(() => parseRefresh(s)).toThrow(EdidEncodeError);
  });
});

describe("exact solver", () => {
  it("finds an exact 59.94 timing when blanking can absorb the 1001 divisor", () => {
    const r = buildTiming({ hActive: 1920, vActive: 1080, refresh: "60000/1001", formula: "exact", slack: { lines: 120, pixels: 400 } });
    if (r.exact) expect(r.errorPpm).toBe(0);
    else expect(r.notes.join(" ")).toMatch(/closest/);
  });

  it("CVT-RB v2's 1 kHz clock is rounded to 10 kHz and the error reported", () => {
    const r = buildTiming({ hActive: 3840, vActive: 2160, refresh: "50", formula: "cvt-rb2" });
    expect(r.formulaClockKHz).toBe(433356);
    expect(r.timing.pixelClock10kHz).toBe(43336);
    expect(r.exact).toBe(false);
    expect(r.notes.join(" ")).toMatch(/10 kHz steps/);
  });

  it("warns below 160 pixels of horizontal blanking", () => {
    const r = buildTiming({ hActive: 3840, vActive: 2160, refresh: "50", formula: "cvt-rb2" });
    expect(r.notes.join(" ")).toMatch(/HDMI-safe/);
  });
});
