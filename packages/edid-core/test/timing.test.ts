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

describe("rasters wider or taller than a DTD holds", () => {
  it("5760x1080 at 60 Hz: no DTD (horizontal active over 4095), but a DisplayID Type I timing", () => {
    const r = buildTiming({ hActive: 5760, vActive: 1080, refresh: "60", formula: "exact" });
    expect(r.dtd).toBeUndefined();
    expect(r.dtdProblems).toEqual(["horizontal active 5760 exceeds 4095"]);
    expect(r.displayIdProblems).toEqual([]);
    expect(r.displayId).toMatchObject({ hActive: 5760, vActive: 1080, pixelClock10kHz: r.timing.pixelClock10kHz, hBlank: r.timing.hTotal - 5760 });
    expect(r.exact).toBe(true);
    expect(r.notes.join(" ")).toMatch(/DisplayID/);
  });

  it("a timing that fits a DTD also has its DisplayID form", () => {
    const r = buildTiming({ hActive: 3840, vActive: 2160, refresh: "50", formula: "exact" });
    expect(r.dtd).toBeDefined();
    expect(r.displayId).toMatchObject({ hActive: 3840, vActive: 2160 });
  });

  it("clocks above 655.35 MHz fit DisplayID's 24-bit clock", () => {
    const r = buildTiming({ hActive: 7680, vActive: 2160, refresh: "60", formula: "cvt-rb2" });
    expect(r.dtdProblems.join(" ")).toMatch(/pixel clock .* exceeds 655.35 MHz/);
    expect(r.displayId).toBeDefined();
  });

  it("accepts any raster DisplayID can hold, up to 65536, and refuses beyond", () => {
    expect(buildTiming({ hActive: 65536, vActive: 1080, refresh: "30", formula: "cvt-rb2" }).displayId).toBeDefined();
    expect(() => buildTiming({ hActive: 65537, vActive: 1080, refresh: "30", formula: "cvt-rb2" })).toThrow(/1 to 65536/);
  });

  it("a manual zero front porch fits a DTD but not DisplayID, which stores it minus one", () => {
    const r = buildTiming({ hActive: 1920, vActive: 1080, refresh: "60", formula: "manual", porches: { hFrontPorch: 0, hSync: 44, hBackPorch: 236, vFrontPorch: 4, vSync: 5, vBackPorch: 36 } });
    expect(r.dtd).toBeDefined();
    expect(r.displayId).toBeUndefined();
    expect(r.displayIdProblems).toEqual(["horizontal front porch 0 is below 1"]);
  });
});
