// Link capacity known answers from Glenwing's "Guide to Display Cables /
// Adapters v2" (linustechtips.com/topic/729232, Wayback snapshot
// 2026-10-05), whose calculator models FRL and UHBR overheads. The HDMI and
// DisplayPort specifications are not available to us (paid, under NDA).
// Its tables assume 8 bpc RGB and CVT-RB v2 and list the highest standard
// refresh that fits; each case checks that it fits and the next step does not.
// The calculator is newer than the tables (its changelog: FRL FEC overhead
// v2.5.7, 2022; FRL blanking compression v2.6.0, 2024; tables last updated
// v2.5.0, 2020), so where a table cell disagrees with the calculator's
// formulas, the formulas win; those cells are pinned at the bottom.

import { describe, expect, it } from "vitest";
import { buildTiming, feasibility, FRL_RATES, frlRateFor, LINKS } from "../src/index.ts";
import type { Link } from "../src/index.ts";

/** Standard refresh steps from the guide's tables. */
const STEPS = [24, 30, 50, 60, 75, 85, 100, 120, 144, 165, 180, 200, 240, 300, 360, 420, 480, 540, 600];

function fits(link: Link, w: number, h: number, hz: number): boolean {
  const r = buildTiming({ hActive: w, vActive: h, refresh: String(hz), formula: "cvt-rb2" });
  const t = r.timing;
  const row = feasibility(r.formulaClockKHz, link, { hActive: t.hActive, hTotal: t.hTotal, vTotal: t.vTotal }).find((x) => x.format === "rgb" && x.depth === 8);
  return row?.fits ?? false;
}

describe("published maximum data rates", () => {
  it("DisplayPort UHBR: 128b/132b, then 383/384 and 16384/16385", () => {
    // The table prints 38.69; the factors give 38.6845.
    expect((LINKS["dp2.1-uhbr10"].payloadKbps ?? 0) / 1e6).toBeCloseTo(38.6845, 4);
    expect(((LINKS["dp2.1-uhbr13.5"].payloadKbps ?? 0) / 1e6).toFixed(2)).toBe("52.22");
    expect(((LINKS["dp2.1-uhbr20"].payloadKbps ?? 0) / 1e6).toFixed(2)).toBe("77.37");
    expect(((LINKS["dp1.4"].payloadKbps ?? 0) / 1e6).toFixed(2)).toBe("25.92");
  });

  it("HDMI FRL: 16b/18b, Reed-Solomon 251/255, 2040/2044 (2040/2043 on three lanes), 2007/2008; FRL 48G is 41.89", () => {
    expect(FRL_RATES.map((r) => (r.payloadKbps / 1e6).toFixed(2))).toEqual(["7.86", "15.72", "20.95", "27.93", "34.91", "41.89"]);
  });
});

const CASES: readonly (readonly [Link, number, number, number])[] = [
  // HDMI 2.1, FRL 48G: 1440p 360, 4K 180, 5K 100 (5120x2880), 8K 50 (3440x1440 is pinned below).
  ["hdmi2.1", 2560, 1440, 360],
  ["hdmi2.1", 3840, 2160, 180],
  ["hdmi2.1", 5120, 2880, 100],
  ["hdmi2.1", 7680, 4320, 50],
  // DisplayPort HBR2, HBR3, UHBR10, UHBR20 at 3840x2160: 75, 120, 165, 300 (UHBR13.5 is pinned below).
  ["dp1.2", 3840, 2160, 75],
  ["dp1.4", 3840, 2160, 120],
  ["dp2.1-uhbr10", 3840, 2160, 165],
  ["dp2.1-uhbr20", 3840, 2160, 300],
  // 8K: HBR3 30, UHBR13.5 60, UHBR20 85. 1440p: HBR3 240.
  ["dp1.4", 7680, 4320, 30],
  ["dp2.1-uhbr13.5", 7680, 4320, 60],
  ["dp2.1-uhbr20", 7680, 4320, 85],
  ["dp1.4", 2560, 1440, 240],
];

describe("maximum refresh tables (8 bpc RGB, CVT-RB v2)", () => {
  for (const [link, w, h, hz] of CASES) {
    const next = STEPS.find((s) => s > hz) ?? hz + 60;
    it(`${LINKS[link].name}: ${w}x${h} fits at ${hz} Hz, not at ${next} Hz`, () => {
      expect(fits(link, w, h, hz)).toBe(true);
      expect(fits(link, w, h, next)).toBe(false);
    });
  }
});

describe("table cells the calculator's formulas overrule", () => {
  it("HDMI 2.1, 3440x1440 at 300 Hz: needs 42.10 Gbps, above 41.89 (the table predates the FEC adjustment, when FRL 48G was 42.67)", () => {
    expect(fits("hdmi2.1", 3440, 1440, 300)).toBe(false);
    expect(fits("hdmi2.1", 3440, 1440, 240)).toBe(true);
  });

  it("UHBR13.5, 3840x2160 at 240 Hz: needs 54.85 Gbps, above even the 54 Gbps raw rate; 200 Hz (44.8 Gbps) is the limit", () => {
    expect(fits("dp2.1-uhbr13.5", 3840, 2160, 240)).toBe(false);
    expect(fits("dp2.1-uhbr13.5", 3840, 2160, 200)).toBe(true);
  });
});

describe("FRL rate selection uses the full model", () => {
  it("4K120 8-bit RGB (CVT-RB v2) needs FRL 8 Gbps x 4", () => {
    const r = buildTiming({ hActive: 3840, vActive: 2160, refresh: "120", formula: "cvt-rb2" });
    const t = r.timing;
    expect(frlRateFor({ pixelClockKHz: r.formulaClockKHz, hActive: t.hActive, hTotal: t.hTotal, vTotal: t.vTotal }, "rgb", 8)?.code).toBe(4);
  });
});
