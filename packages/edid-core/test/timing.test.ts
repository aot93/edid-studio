import { describe, expect, it } from "vitest";
import kat from "./data/cvt-kat.json" with { type: "json" };
import gtfKat from "./data/gtf-kat.json" with { type: "json" };
import { buildTiming, calcCvt, calcGtf, EdidEncodeError, lookupDmt, parseRefresh } from "../src/index.ts";
import type { Formula, Rb3Options } from "../src/index.ts";

const FORMULA_BY_RB: Record<number, Formula> = { 0: "cvt", 1: "cvt-rb", 2: "cvt-rb2", 3: "cvt-rb3" };

describe("CVT known answers from edid-decode", () => {
  for (const r of kat.rows) {
    const rb3: Rb3Options | undefined =
      "rb3" in r && r.rb3 ? { hBlank: r.rb3.hblank, ...("vblank" in r.rb3 ? { vBlankUs: r.rb3.vblank } : {}), ...("earlyVsync" in r.rb3 ? { earlyVsync: true } : {}) } : undefined;
    it(`${r.w}x${r.h}@${r.fps} rb=${r.rb}${rb3 ? ` ${JSON.stringify(rb3)}` : ""}`, () => {
      const c = calcCvt(r.w, r.h, r.fps, r.rb as 0 | 1 | 2 | 3, rb3);
      expect(c.clockKHz).toBe(r.clockKHz);
      expect(c.porches).toEqual({
        hFrontPorch: r.hFrontPorch, hSync: r.hSync, hBackPorch: r.hBackPorch,
        vFrontPorch: r.vFrontPorch, vSync: r.vSync, vBackPorch: r.vBackPorch,
      });
      const formula = FORMULA_BY_RB[r.rb] ?? "cvt";
      const built = buildTiming({ hActive: r.w, vActive: r.h, refresh: String(r.fps), formula, ...(rb3 ? { rb3 } : {}) });
      expect([built.timing.hSyncPositive, built.timing.vSyncPositive]).toEqual([r.hSyncPositive, r.vSyncPositive]);
    });
  }
});

describe("GTF known answers from edid-decode", () => {
  for (const r of gtfKat.rows) {
    it(`${r.w}x${r.h}@${r.fps}`, () => {
      const g = calcGtf(r.w, r.h, r.fps);
      expect(g.clockKHz).toBe(r.clockKHz);
      expect(g.porches).toEqual({
        hFrontPorch: r.hFrontPorch, hSync: r.hSync, hBackPorch: r.hBackPorch,
        vFrontPorch: r.vFrontPorch, vSync: r.vSync, vBackPorch: r.vBackPorch,
      });
      const built = buildTiming({ hActive: r.w, vActive: r.h, refresh: String(r.fps), formula: "gtf" });
      expect([built.timing.hSyncPositive, built.timing.vSyncPositive]).toEqual([r.hSyncPositive, r.vSyncPositive]);
    });
  }

  it("refuses a GTF timing whose front porch comes out negative (edid-decode: 292x176 at 76 Hz, Hfront -8)", () => {
    expect(() => buildTiming({ hActive: 296, vActive: 176, refresh: "76", formula: "gtf" })).toThrow(/horizontal front porch of -8/);
  });
});

describe("VIC and DMT lookups", () => {
  it("VIC lookup gives the CTA-861 timing exactly (VIC 96, 3840x2160 at 50 Hz)", () => {
    const r = buildTiming({ hActive: 3840, vActive: 2160, refresh: "50", formula: "vic" });
    expect(r.timing).toMatchObject({ hFrontPorch: 1056, hSync: 88, hBackPorch: 296, vFrontPorch: 8, vSync: 10, vBackPorch: 72, pixelClock10kHz: 59400, hSyncPositive: true, vSyncPositive: true });
    expect(r.exact).toBe(true);
    // VIC 106 is the 64:27 twin of VIC 96, with the same timing.
    expect(r.encodings).toEqual({ dtd: false, displayId: true, vics: [96, 106], dmts: [] });
  });

  it("a 1000/1001 rate uses the VIC's porches with the clock divided by 1.001 (VIC 16 at 59.94 Hz)", () => {
    const r = buildTiming({ hActive: 1920, vActive: 1080, refresh: "60000/1001", formula: "vic" });
    expect(r.timing).toMatchObject({ hTotal: 2200, vTotal: 1125, pixelClock10kHz: 14835 });
    expect(r.exact).toBe(false);
    expect(r.encodings.vics).toContain(16);
  });

  it("DMT lookup gives the VESA timing (DMT 0x52, 1920x1080 at 60 Hz)", () => {
    expect(lookupDmt(0x52)).toMatchObject({ hActive: 1920, vActive: 1080, pixelClockKHz: 148500 });
    const r = buildTiming({ hActive: 1920, vActive: 1080, refresh: "60", formula: "dmt" });
    expect(r.timing).toMatchObject({ hFrontPorch: 88, hSync: 44, hBackPorch: 148, vFrontPorch: 4, vSync: 5, vBackPorch: 36, pixelClock10kHz: 14850 });
    expect(r.encodings.dmts).toEqual([0x52]);
    expect(r.encodings.vics).toEqual([16, 76]);
  });

  it("DMT reduced-blanking entries match CVT-RB (DMT 0x26, 1280x1024 at 120 Hz RB)", () => {
    const r = buildTiming({ hActive: 1280, vActive: 1024, refresh: "120", formula: "cvt-rb" });
    expect(lookupDmt(0x26)).toMatchObject({ pixelClockKHz: r.timing.pixelClock10kHz * 10 });
  });

  it("says which raster and rate it could not find", () => {
    expect(() => buildTiming({ hActive: 5760, vActive: 1080, refresh: "60", formula: "vic" })).toThrow("no CTA-861 VIC is 5760x1080 at 60 Hz");
    expect(() => buildTiming({ hActive: 3840, vActive: 2160, refresh: "50", formula: "dmt" })).toThrow("no VESA DMT timing is 3840x2160 at 50 Hz");
  });
});

describe("encodings list (SPEC.md section 6)", () => {
  it("a reduced-blanking 4K50 fits a DTD and DisplayID and matches no standard timing", () => {
    expect(buildTiming({ hActive: 3840, vActive: 2160, refresh: "50", formula: "exact" }).encodings).toEqual({ dtd: true, displayId: true, vics: [], dmts: [] });
  });

  it("acceptance test 4: VIC 96 entered by hand offers the VIC route as well as reduced blanking", () => {
    const r = buildTiming({
      hActive: 3840, vActive: 2160, refresh: "50", formula: "manual",
      porches: { hFrontPorch: 1056, hSync: 88, hBackPorch: 296, vFrontPorch: 8, vSync: 10, vBackPorch: 72 },
      hSyncPositive: true, vSyncPositive: true,
    });
    expect(r.encodings.vics).toEqual([96, 106]);
    expect(r.notes.join(" ")).toMatch(/VIC 96/);
    expect(r.notes.join(" ")).toMatch(/reduced blanking/);
  });
});

describe("HDMI blanking heuristic", () => {
  it("is 160 pixels by default and configurable", () => {
    const req = { hActive: 3840, vActive: 2160, refresh: "50", formula: "cvt-rb" } as const;
    expect(buildTiming(req).notes.join(" ")).not.toMatch(/HDMI-safe/);
    expect(buildTiming({ ...req, minHdmiHBlank: 200 }).notes.join(" ")).toMatch(/under 200 pixels/);
  });
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
