// SPEC.md section 15, acceptance tests 1, 2 (link part), 3, 4 and 9.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTiming, dtdFieldProblems, feasibility, importEdid, lookupVic, runRecipe, serializeEdid } from "../src/index.ts";
import type { DetailedTimingDescriptor, Recipe } from "../src/index.ts";
import { FIXTURES_DIR } from "./corpus.ts";

const fixture = (name: string) => importEdid(readFileSync(join(FIXTURES_DIR, name), "utf8"));
const hex = (b: ArrayLike<number>) => Array.from(b, (v) => v.toString(16).padStart(2, "0")).join(" ");

describe("acceptance test 1: reproduce the fix", () => {
  // The recipe from SPEC.md section 9, verbatim.
  const recipe: Recipe = {
    recipe: 1,
    base: { file: "Tessera-EJE-test.txt" },
    ops: [
      { op: "keepOnlyModes", modes: [] },
      {
        op: "setPreferredTiming", width: 3840, height: 2160, refresh: "50",
        formula: "exact-refresh", hBlank: 160, vBlankLines: 60,
        hFrontPorch: 48, hSync: 32, vFrontPorch: 8, vSync: 10,
        polarity: "H+V-",
      },
      { op: "setColor", formats: ["rgb"], depths: [10] },
      { op: "setRangeLimits", vHz: [50, 50], hKHz: [110, 113], maxClockMHz: 600, gtf: "none" },
    ],
  };

  it("turns the original into the working EDID byte for byte", () => {
    const original = fixture("Tessera-EJE-test.txt");
    const fixed = fixture("Tessera-EJE-4K50-10bit-RGB.txt");
    const out = serializeEdid(runRecipe(original.edid, recipe));
    expect(out.length).toBe(256);
    expect(hex(out)).toBe(hex(fixed.bytes));
  });

  it("matches the expectations written in the recipe", () => {
    const out = serializeEdid(runRecipe(fixture("Tessera-EJE-test.txt").edid, recipe));
    expect(hex(out.subarray(54, 72))).toBe("70 ad 00 a0 f0 70 3c 80 30 20 8a 00 00 00 00 00 00 1a");
    expect([out[127], out[255]].map((v) => (v ?? 0).toString(16))).toEqual(["bf", "d6"]);
  });

  it("the original fixture has the checksums the spec records", () => {
    const b = fixture("Tessera-EJE-test.txt").bytes;
    expect([b[127], b[255]].map((v) => (v ?? 0).toString(16))).toEqual(["32", "2c"]);
  });
});

describe("acceptance test 2 (link budget part): explain the failure", () => {
  // The full validate command arrives with M1; the arithmetic is here.
  const at = (clockKHz: number, format: "rgb" | "ycbcr422" | "ycbcr420", depth: 10) =>
    feasibility(clockKHz, "hdmi2.0").find((r) => r.format === format && r.depth === depth);

  it.each([
    [594_000, "rgb", 742_500, false],
    [444_000, "rgb", 555_000, true],
    [594_000, "ycbcr422", 594_000, true],
    [594_000, "ycbcr420", 371_250, true],
  ] as const)("%i kHz %s 10-bit needs %i kHz TMDS; fits HDMI 2.0: %s", (clock, format, rate, fits) => {
    expect(at(clock, format, 10)).toMatchObject({ rateKHz: rate, fits });
  });
});

describe("acceptance test 3: exact refresh", () => {
  it("3840x2160 at 50 Hz with 160/60 blanking is 4000 x 2220, 444 MHz, 0 ppm", () => {
    const r = buildTiming({
      hActive: 3840, vActive: 2160, refresh: "50", formula: "manual",
      porches: { hFrontPorch: 48, hSync: 32, hBackPorch: 80, vFrontPorch: 8, vSync: 10, vBackPorch: 42 },
    });
    expect(r.timing).toMatchObject({ hTotal: 4000, vTotal: 2220, pixelClock10kHz: 44400 });
    expect(r.achievedHz).toBe(50);
    expect(r.errorPpm).toBe(0);
    expect(r.exact).toBe(true);
  });

  it("the exact solver lands on 50.000 Hz where CVT-RB v1 gives 49.977 Hz", () => {
    const cvt = buildTiming({ hActive: 3840, vActive: 2160, refresh: "50", formula: "cvt-rb" });
    expect(cvt.timing.pixelClock10kHz).toBe(44200);
    expect(cvt.exact).toBe(false);
    expect(cvt.achievedHz).toBeCloseTo(49.977, 3);

    const exact = buildTiming({ hActive: 3840, vActive: 2160, refresh: "50", formula: "exact" });
    expect(exact.exact).toBe(true);
    expect(exact.achievedHz).toBe(50);
    expect(exact.timing.hFrontPorch + exact.timing.hSync + exact.timing.hBackPorch).toBeGreaterThanOrEqual(160);
  });
});

describe("acceptance test 4: refuse the impossible", () => {
  it("VIC 96 cannot be a DTD: front porch 1056 exceeds 1023, with alternatives offered", () => {
    const v = lookupVic(96);
    if (!v) throw new Error("VIC 96 missing");
    const r = buildTiming({
      hActive: 3840, vActive: 2160, refresh: "50", formula: "manual",
      porches: { hFrontPorch: 1056, hSync: 88, hBackPorch: 296, vFrontPorch: 8, vSync: 10, vBackPorch: 72 },
    });
    expect(r.timing.pixelClock10kHz * 10).toBe(v.pixelClockKHz);
    expect(r.dtd).toBeUndefined();
    expect(r.dtdProblems).toContain("horizontal front porch 1056 exceeds 1023");
    expect(r.notes.join(" ")).toMatch(/reduced blanking/);
  });

  it("dtdFieldProblems names every overflowing field", () => {
    const d: DetailedTimingDescriptor = {
      kind: "dtd", pixelClock10kHz: 70000, hActive: 5000, hBlank: 100, vActive: 100, vBlank: 100,
      hFrontPorch: 10, hSync: 10, vFrontPorch: 64, vSync: 5, hImageMm: 0, vImageMm: 0, hBorder: 0, vBorder: 0, flags: 0x18,
    };
    expect(dtdFieldProblems(d)).toEqual(["pixel clock 700.00 MHz exceeds 655.35 MHz", "horizontal active 5000 exceeds 4095", "vertical front porch 64 exceeds 63"]);
  });
});

describe("acceptance test 9: honest rounding", () => {
  it("a 59.94 Hz request reports its ppm error and is never called exact", () => {
    const r = buildTiming({ hActive: 1920, vActive: 1080, refresh: "59.94", formula: "cvt-rb" });
    expect(r.exact).toBe(false);
    expect(r.errorPpm).not.toBe(0);
    expect(Math.abs(r.errorPpm)).toBeLessThan(2000);
  });

  it("60000/1001 is parsed exactly and reported against the true fraction", () => {
    const r = buildTiming({
      hActive: 1920, vActive: 1080, refresh: "60000/1001", formula: "manual",
      porches: { hFrontPorch: 88, hSync: 44, hBackPorch: 148, vFrontPorch: 4, vSync: 5, vBackPorch: 36 },
    });
    // 2200 x 1125 x 60000/1001 = 148.351648... MHz; a DTD holds 148.35 MHz.
    expect(r.timing.pixelClock10kHz).toBe(14835);
    expect(r.exact).toBe(false);
    expect(r.targetHz).toBeCloseTo(59.94006, 5);
    expect(r.errorPpm).toBeCloseTo(-11.1, 1);
  });
});

describe("acceptance test 2: explain the failure on the original", () => {
  it("warns that 10-bit RGB needs 742.5 MHz at 594 MHz and lists 4:2:2 and 4:2:0 as fitting", async () => {
    const { analyzeLink } = await import("../src/index.ts");
    const reports = analyzeLink(fixture("Tessera-EJE-test.txt").edid, "hdmi2.0");
    const dtd = reports.find((r) => r.mode === "Timing 3840x2160 @ 60.000 Hz");
    expect(dtd?.message).toContain("at 594.00 MHz: 10-bit RGB needs 742.50 MHz, 12-bit RGB needs 891.00 MHz TMDS, above HDMI 2.0's 600 MHz TMDS.");
    expect(dtd?.tooFast.map((r) => [r.depth, r.rateKHz])).toEqual([[10, 742_500], [12, 891_000]]);
    // The DTD is not in the 4:2:0 map, so only 4:2:2 is offered for it.
    expect(dtd?.alternatives.map((a) => a.format)).toEqual(["ycbcr422"]);
    const vic97 = reports.find((r) => r.mode.startsWith("VIC 97"));
    expect(vic97?.alternatives.map((a) => a.format)).toEqual(["ycbcr422", "ycbcr420"]);
    expect(vic97?.message).toMatch(/10-bit fits as YCbCr 4:2:2 \(594.00 MHz\) or YCbCr 4:2:0 \(371.25 MHz\)/);
  });

  it("finds nothing to warn about in the working EDID", async () => {
    const { analyzeLink } = await import("../src/index.ts");
    const reports = analyzeLink(fixture("Tessera-EJE-4K50-10bit-RGB.txt").edid, "hdmi2.0");
    expect(reports.map((r) => r.message)).toEqual([""]);
  });
});

describe("likely driver choice (SPEC.md section 7, a labelled heuristic)", () => {
  it("the original lands on 8-bit RGB at 594 MHz: the fallback seen on the Tessera", async () => {
    const { analyzeLink } = await import("../src/index.ts");
    const reports = analyzeLink(fixture("Tessera-EJE-test.txt").edid, "hdmi2.0");
    const dtd = reports.find((r) => r.mode === "Timing 3840x2160 @ 60.000 Hz");
    expect(dtd?.likely).toMatchObject({ format: "rgb", depth: 8, rateKHz: 594_000 });
  });

  it("the working EDID lands on 10-bit RGB at 555 MHz", async () => {
    const { analyzeLink } = await import("../src/index.ts");
    const [only] = analyzeLink(fixture("Tessera-EJE-4K50-10bit-RGB.txt").edid, "hdmi2.0");
    expect(only?.likely).toMatchObject({ format: "rgb", depth: 10, rateKHz: 555_000 });
  });

  it("lists every advertised format and depth per mode, so the UI can mark them", async () => {
    const { analyzeLink } = await import("../src/index.ts");
    const [only] = analyzeLink(fixture("Tessera-EJE-4K50-10bit-RGB.txt").edid, "hdmi2.0");
    expect(only?.advertised.map((a) => `${a.format}-${a.depth}`)).toEqual(["rgb-8", "rgb-10"]);
  });
});
