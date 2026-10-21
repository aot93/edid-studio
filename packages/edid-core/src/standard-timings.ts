// CTA-861 VIC and VESA DMT timings with their porches, for the "VIC" and
// "DMT" formulas and for spotting when a timing is a standard one (SPEC.md
// section 6, encodings list). Tables are generated from edid-decode.

import { CTA_VIC_ROWS } from "./data/cta-vics.ts";
import { DMT_ROWS } from "./data/dmt.ts";

/** A progressive standard timing. Borders are folded into the porches, as a DTD's blanking includes them. */
export interface StandardTiming {
  readonly hActive: number;
  readonly vActive: number;
  readonly pixelClockKHz: number;
  readonly hFrontPorch: number;
  readonly hSync: number;
  readonly hBackPorch: number;
  readonly vFrontPorch: number;
  readonly vSync: number;
  readonly vBackPorch: number;
  readonly hSyncPositive: boolean;
  readonly vSyncPositive: boolean;
}

export interface VicTiming extends StandardTiming {
  readonly vic: number;
}

export interface DmtTiming extends StandardTiming {
  readonly dmt: number;
  /** 0 none, 1 CVT-RB v1, 2 CVT-RB v2. */
  readonly reducedBlanking: number;
}

/** Progressive VICs only; interlaced formats are not offered as formulas. */
const VIC_TIMINGS: readonly VicTiming[] = CTA_VIC_ROWS.filter((r) => r[6] === 0).map(
  ([vic, hActive, vActive, , , pixelClockKHz, , hFrontPorch, hSync, hBackPorch, hp, vFrontPorch, vSync, vBackPorch, vp]) => ({
    vic,
    hActive,
    vActive,
    pixelClockKHz,
    hFrontPorch,
    hSync,
    hBackPorch,
    vFrontPorch,
    vSync,
    vBackPorch,
    hSyncPositive: hp === 1,
    vSyncPositive: vp === 1,
  }),
);

/**
 * Progressive DMT timings. edid-decode keeps 640x480's 8-pixel and 8-line
 * borders apart from the porches; here each border joins the porch beside
 * it, so DMT 0x04 reads 16/96/48 and 10/2/33.
 */
const DMT_TIMINGS: readonly DmtTiming[] = DMT_ROWS.filter((r) => r[8] === 0).map(
  ([dmt, , hActive, vActive, , , pixelClockKHz, rb, , hfp, hSync, hbp, hp, vfp, vSync, vbp, vp, hb, vb]) => ({
    dmt,
    reducedBlanking: rb,
    hActive,
    vActive,
    pixelClockKHz,
    hFrontPorch: hfp + hb,
    hSync,
    hBackPorch: hbp + hb,
    vFrontPorch: vfp + vb,
    vSync,
    vBackPorch: vbp + vb,
    hSyncPositive: hp === 1,
    vSyncPositive: vp === 1,
  }),
);

export function lookupDmt(id: number): DmtTiming | undefined {
  return DMT_TIMINGS.find((t) => t.dmt === id);
}

function totals(t: StandardTiming): number {
  return (t.hActive + t.hFrontPorch + t.hSync + t.hBackPorch) * (t.vActive + t.vFrontPorch + t.vSync + t.vBackPorch);
}

/** Refresh in Hz of a standard timing. */
export function standardRefreshHz(t: StandardTiming): number {
  return (t.pixelClockKHz * 1000) / totals(t);
}

/**
 * Finds a standard timing for this raster and rate. A rate within 0.05% of
 * the table's is the table's own; one within 0.05% of the table's divided by
 * 1.001 (59.94 for 60) is its 1000/1001 variant, which CTA-861 sinks accept
 * under the same VIC. The lowest ID wins.
 */
function find<T extends StandardTiming>(table: readonly T[], hActive: number, vActive: number, hz: number): { timing: T; clockKHz: number } | undefined {
  const near = (a: number, b: number) => Math.abs(a - b) / b < 0.0005;
  for (const t of table) {
    if (t.hActive !== hActive || t.vActive !== vActive) continue;
    const own = standardRefreshHz(t);
    if (near(own, hz)) return { timing: t, clockKHz: t.pixelClockKHz };
    if (near(own / 1.001, hz)) return { timing: t, clockKHz: t.pixelClockKHz / 1.001 };
  }
  return undefined;
}

export function findVic(hActive: number, vActive: number, hz: number): { timing: VicTiming; clockKHz: number } | undefined {
  return find(VIC_TIMINGS, hActive, vActive, hz);
}

export function findDmt(hActive: number, vActive: number, hz: number): { timing: DmtTiming; clockKHz: number } | undefined {
  return find(DMT_TIMINGS, hActive, vActive, hz);
}

/**
 * VICs and DMT IDs whose timing this is: same raster, porches and polarity,
 * and the table clock or its 1000/1001 variant to within one 10 kHz step.
 */
export function matchingStandards(t: StandardTiming): { vics: number[]; dmts: number[] } {
  const same = (s: StandardTiming) =>
    s.hActive === t.hActive &&
    s.vActive === t.vActive &&
    s.hFrontPorch === t.hFrontPorch &&
    s.hSync === t.hSync &&
    s.hBackPorch === t.hBackPorch &&
    s.vFrontPorch === t.vFrontPorch &&
    s.vSync === t.vSync &&
    s.vBackPorch === t.vBackPorch &&
    s.hSyncPositive === t.hSyncPositive &&
    s.vSyncPositive === t.vSyncPositive &&
    (Math.abs(s.pixelClockKHz - t.pixelClockKHz) < 10 || Math.abs(s.pixelClockKHz / 1.001 - t.pixelClockKHz) < 10);
  return { vics: VIC_TIMINGS.filter(same).map((s) => s.vic), dmts: DMT_TIMINGS.filter(same).map((s) => s.dmt) };
}
