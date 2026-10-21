// Timing engine: turns "width x height at a refresh rate" into an exact,
// encodable timing, or says precisely why it cannot (SPEC.md section 6).
//
// CVT, CVT-RB v1, v2 and v3 and GTF are ported from edid-decode
// calc-gtf-cvt.cpp calc_cvt_mode() and calc_gtf_mode() (MIT), progressive
// and without margins. Known-answer tests compare against edid-decode --cvt
// and --gtf. VIC and DMT timings come from edid-decode's tables.

import { serializeDescriptor } from "./descriptors.ts";
import { displayIdTimingProblems } from "./displayid.ts";
import { EdidEncodeError } from "./errors.ts";
import type { DetailedTimingDescriptor, DisplayIdTiming } from "./model.ts";
import { findDmt, findVic, matchingStandards } from "./standard-timings.ts";

/** Largest active size any encoding here holds: DisplayID Type I's 16 bits, stored minus one. */
export const MAX_ACTIVE = 65536;

/** A refresh rate as an exact fraction, so 59.94 Hz can be 60000/1001. */
export interface Rational {
  readonly num: number;
  readonly den: number;
}

export type Formula = "manual" | "exact" | "cvt" | "cvt-rb" | "cvt-rb2" | "cvt-rb3" | "gtf" | "vic" | "dmt";

export const FORMULA_NAMES: Record<Formula, string> = {
  exact: "Exact refresh (HDMI-safe RB)",
  "cvt-rb": "CVT reduced blanking v1",
  "cvt-rb2": "CVT reduced blanking v2",
  "cvt-rb3": "CVT reduced blanking v3",
  cvt: "CVT",
  gtf: "GTF",
  vic: "CTA-861 VIC lookup",
  dmt: "VESA DMT lookup",
  manual: "Manual porches",
};

/** CVT-RB v3 options (VESA CVT 2.0; edid-decode --cvt hblank, vblank, early-vsync). */
export interface Rb3Options {
  /** Horizontal blanking, 80 to 200 pixels in steps of 8. Default 80; 160 is the "alt" variant. */
  readonly hBlank?: number;
  /** Minimum vertical blanking interval in microseconds, 460 by default. */
  readonly vBlankUs?: number;
  /** Puts vsync early in the vertical blank (half the blanking as back porch). */
  readonly earlyVsync?: boolean;
}

/** Default for the HDMI blanking heuristic (SPEC.md section 6): configurable, not a spec constant. */
export const DEFAULT_MIN_HDMI_HBLANK = 160;

export interface Porches {
  readonly hFrontPorch: number;
  readonly hSync: number;
  readonly hBackPorch: number;
  readonly vFrontPorch: number;
  readonly vSync: number;
  readonly vBackPorch: number;
}

export interface TimingRequest {
  readonly hActive: number;
  readonly vActive: number;
  /** "50", "59.94", "60000/1001", or a Rational. */
  readonly refresh: string | Rational;
  readonly formula: Formula;
  /** Manual: every porch. Exact: the minimum porches; extra blanking goes to the back porches. */
  readonly porches?: Porches;
  /** Positive sync polarity. Defaults by formula: CVT H- V+, reduced blanking H+ V-. */
  readonly hSyncPositive?: boolean;
  readonly vSyncPositive?: boolean;
  /** Exact solver: how many extra lines and pixels it may add to the blanking. */
  readonly slack?: { readonly lines: number; readonly pixels: number };
  /** CVT-RB v3 options. */
  readonly rb3?: Rb3Options;
  /** Warn below this much horizontal blanking with reduced-blanking formulas. Default 160. */
  readonly minHdmiHBlank?: number;
}

/** How a timing can be carried (SPEC.md section 6). */
export interface Encodings {
  /** Fits an 18-byte detailed timing descriptor. */
  readonly dtd: boolean;
  /** Fits a DisplayID Type I timing. */
  readonly displayId: boolean;
  /** CTA-861 VICs with this exact timing (or its 1000/1001 variant): a short video descriptor can carry it. */
  readonly vics: readonly number[];
  /** VESA DMT IDs with this exact timing. */
  readonly dmts: readonly number[];
}

export interface Timing extends Porches {
  readonly hActive: number;
  readonly vActive: number;
  readonly hTotal: number;
  readonly vTotal: number;
  readonly hSyncPositive: boolean;
  readonly vSyncPositive: boolean;
  /** As stored in a DTD: whole units of 10 kHz. */
  readonly pixelClock10kHz: number;
}

export interface TimingResult {
  readonly request: TimingRequest;
  readonly timing: Timing;
  /** The clock the formula asked for before DTD rounding, in kHz. */
  readonly formulaClockKHz: number;
  readonly targetHz: number;
  readonly achievedHz: number;
  /** Parts per million, achieved versus target. 0 when exact. */
  readonly errorPpm: number;
  /** True only when the stored clock gives the target rate with no error at all. */
  readonly exact: boolean;
  /** The DTD for this timing; present only when every field fits. */
  readonly dtd?: DetailedTimingDescriptor;
  /** Field-limit failures, each naming the field, e.g. "horizontal front porch 1056 exceeds 1023". */
  readonly dtdProblems: readonly string[];
  /** The DisplayID Type I timing; present only when every field fits. Carries rasters a DTD cannot. */
  readonly displayId?: DisplayIdTiming;
  /** Type I field-limit failures, by field name. */
  readonly displayIdProblems: readonly string[];
  readonly encodings: Encodings;
  /** Warnings and suggestions in plain language. */
  readonly notes: readonly string[];
}

/** Parses "50", "59.94", "60000/1001" or "23.976" into an exact fraction. */
export function parseRefresh(input: string | Rational): Rational {
  if (typeof input !== "string") return input;
  const s = input.trim();
  const frac = /^(\d+)\s*\/\s*(\d+)$/.exec(s);
  if (frac) return reduce({ num: Number(frac[1]), den: Number(frac[2]) });
  const dec = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s);
  if (dec) {
    const decimals = dec[2] ?? "";
    return reduce({ num: Number(dec[1] + decimals), den: 10 ** decimals.length });
  }
  throw new EdidEncodeError("refresh", `refresh "${s.slice(0, 20)}" is not a number like 50, 59.94 or 60000/1001`);
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function reduce(r: Rational): Rational {
  if (!Number.isInteger(r.num) || !Number.isInteger(r.den) || r.den <= 0 || r.num <= 0) {
    throw new EdidEncodeError("refresh", "refresh must be a positive number");
  }
  const g = gcd(r.num, r.den);
  return { num: r.num / g, den: r.den / g };
}

export function rationalHz(r: Rational): number {
  return r.num / r.den;
}

function checkRequest(req: TimingRequest): void {
  for (const [name, v] of [
    ["horizontal active", req.hActive],
    ["vertical active", req.vActive],
  ] as const) {
    if (!Number.isInteger(v) || v < 1 || v > MAX_ACTIVE) {
      throw new EdidEncodeError(name, `${name} ${v} must be a whole number from 1 to ${MAX_ACTIVE}`);
    }
  }
  if (req.porches) {
    for (const [k, v] of Object.entries(req.porches)) {
      if (!Number.isInteger(v) || v < 0 || v > MAX_ACTIVE) throw new EdidEncodeError(k, `${k} ${v} must be a whole number from 0`);
    }
  }
}

/** Builds a timing from a request, rounding the clock to a DTD's 10 kHz steps and reporting the error. */
export function buildTiming(req: TimingRequest): TimingResult {
  checkRequest(req);
  const refresh = parseRefresh(req.refresh);
  const rb = req.formula !== "cvt" && req.formula !== "gtf";
  let hPos = req.hSyncPositive ?? rb;
  let vPos = req.vSyncPositive ?? !rb;

  let porches: Porches;
  let clockKHz: number;
  const notes: string[] = [];

  switch (req.formula) {
    case "manual": {
      porches = requirePorches(req);
      const total = (req.hActive + porches.hFrontPorch + porches.hSync + porches.hBackPorch) *
        (req.vActive + porches.vFrontPorch + porches.vSync + porches.vBackPorch);
      clockKHz = (total * refresh.num) / refresh.den / 1000;
      break;
    }
    case "exact": {
      const solved = solveExact(req, refresh);
      porches = solved.porches;
      clockKHz = solved.clockKHz;
      if (!solved.exact) notes.push(`No blanking within the allowed slack gives exactly ${fmtHz(rationalHz(refresh))} Hz with a 10 kHz clock step; this is the closest.`);
      break;
    }
    case "vic":
    case "dmt": {
      const hz = rationalHz(refresh);
      const found = req.formula === "vic" ? findVic(req.hActive, req.vActive, hz) : findDmt(req.hActive, req.vActive, hz);
      if (!found) {
        const what = req.formula === "vic" ? "CTA-861 VIC" : "VESA DMT timing";
        throw new EdidEncodeError(req.formula, `no ${what} is ${req.hActive}x${req.vActive} at ${fmtHz(hz)} Hz`);
      }
      const t = found.timing;
      porches = { hFrontPorch: t.hFrontPorch, hSync: t.hSync, hBackPorch: t.hBackPorch, vFrontPorch: t.vFrontPorch, vSync: t.vSync, vBackPorch: t.vBackPorch };
      clockKHz = found.clockKHz;
      // The table sets the polarity; an explicit choice still wins.
      hPos = req.hSyncPositive ?? t.hSyncPositive;
      vPos = req.vSyncPositive ?? t.vSyncPositive;
      break;
    }
    case "gtf": {
      const gtf = calcGtf(req.hActive, req.vActive, rationalHz(refresh));
      porches = gtf.porches;
      clockKHz = gtf.clockKHz;
      if (req.hActive % 8 !== 0) notes.push(`GTF rounds the width to a multiple of 8; ${req.hActive} is not one.`);
      break;
    }
    default: {
      const level = req.formula === "cvt" ? 0 : req.formula === "cvt-rb" ? 1 : req.formula === "cvt-rb2" ? 2 : 3;
      const cvt = calcCvt(req.hActive, req.vActive, rationalHz(refresh), level, req.rb3);
      porches = cvt.porches;
      clockKHz = cvt.clockKHz;
      if (req.hActive % 8 !== 0 && req.formula !== "cvt-rb2") notes.push(`CVT rounds the width down to a multiple of 8; ${req.hActive} is not one.`);
    }
  }
  for (const [k, name] of [
    ["hFrontPorch", "horizontal front porch"],
    ["hSync", "horizontal sync width"],
    ["hBackPorch", "horizontal back porch"],
    ["vFrontPorch", "vertical front porch"],
    ["vSync", "vertical sync width"],
    ["vBackPorch", "vertical back porch"],
  ] as const) {
    if (porches[k] < 0) throw new EdidEncodeError(k, `the ${FORMULA_NAMES[req.formula]} formula gives a ${name} of ${porches[k]}, which no timing can hold`);
  }

  const hTotal = req.hActive + porches.hFrontPorch + porches.hSync + porches.hBackPorch;
  const vTotal = req.vActive + porches.vFrontPorch + porches.vSync + porches.vBackPorch;
  const pixelClock10kHz = Math.round(clockKHz / 10);
  const targetHz = rationalHz(refresh);
  const achievedHz = (pixelClock10kHz * 10_000) / (hTotal * vTotal);
  // Exact comparison in integers: clock * den == hTotal * vTotal * num / 10000.
  const exact = pixelClock10kHz * 10_000 * refresh.den === hTotal * vTotal * refresh.num;
  const errorPpm = exact ? 0 : ((achievedHz - targetHz) / targetHz) * 1e6;

  if (!exact && Math.abs(clockKHz / 10 - pixelClock10kHz) > 1e-9) {
    notes.push(
      `The formula asks for ${fmtMHz(clockKHz)}; a DTD stores 10 kHz steps, so it holds ${fmtMHz(pixelClock10kHz * 10)}.`,
    );
  }
  if (req.hActive % 8 !== 0) notes.push(`Width ${req.hActive} is not a multiple of 8; some sources and scalers handle that badly.`);
  const minHBlank = req.minHdmiHBlank ?? DEFAULT_MIN_HDMI_HBLANK;
  if (rb && porches.hFrontPorch + porches.hSync + porches.hBackPorch < minHBlank) {
    notes.push(`Horizontal blanking under ${minHBlank} pixels is not generally HDMI-safe (a heuristic, not a spec limit).`);
  }

  const timing: Timing = { hActive: req.hActive, vActive: req.vActive, ...porches, hTotal, vTotal, hSyncPositive: hPos, vSyncPositive: vPos, pixelClock10kHz };
  const candidate: DetailedTimingDescriptor = {
    kind: "dtd",
    pixelClock10kHz,
    hActive: req.hActive,
    hBlank: hTotal - req.hActive,
    vActive: req.vActive,
    vBlank: vTotal - req.vActive,
    hFrontPorch: porches.hFrontPorch,
    hSync: porches.hSync,
    vFrontPorch: porches.vFrontPorch,
    vSync: porches.vSync,
    hImageMm: 0,
    vImageMm: 0,
    hBorder: 0,
    vBorder: 0,
    // Digital separate sync (bits 4-3 = 11), polarity in bits 2 and 1 (E-EDID 1.4 table 3.22).
    flags: 0x18 | (vPos ? 0x04 : 0) | (hPos ? 0x02 : 0),
  };
  const dtdProblems = dtdFieldProblems(candidate);
  // DisplayID Type I (edid-decode parse_displayid_type_1_7_timing()): same 10 kHz clock unit, preferred flag set by the builder.
  const displayIdCandidate: DisplayIdTiming = {
    pixelClock10kHz,
    flags: 0,
    hActive: req.hActive,
    hBlank: hTotal - req.hActive,
    hFrontPorch: porches.hFrontPorch,
    hSync: porches.hSync,
    hSyncPositive: hPos,
    vActive: req.vActive,
    vBlank: vTotal - req.vActive,
    vFrontPorch: porches.vFrontPorch,
    vSync: porches.vSync,
    vSyncPositive: vPos,
  };
  const displayIdProblems = displayIdTimingProblems(displayIdCandidate);
  const standards = matchingStandards({ ...timing, pixelClockKHz: pixelClock10kHz * 10 });
  if (dtdProblems.length > 0) {
    // A standard timing needs no DTD at all: a short video descriptor names it.
    const vic = standards.vics[0];
    if (vic !== undefined) notes.push(`This is VIC ${vic}'s timing, so a CTA-861 video data block can list it as VIC ${vic} instead of a DTD.`);
    notes.push(...suggestionsFor(candidate, displayIdProblems.length === 0));
  }

  return {
    request: req,
    timing,
    formulaClockKHz: clockKHz,
    targetHz,
    achievedHz,
    errorPpm,
    exact,
    ...(dtdProblems.length === 0 ? { dtd: candidate } : {}),
    dtdProblems,
    ...(displayIdProblems.length === 0 ? { displayId: displayIdCandidate } : {}),
    displayIdProblems,
    encodings: { dtd: dtdProblems.length === 0, displayId: displayIdProblems.length === 0, ...standards },
    notes,
  };
}

/** Every DTD field that overflows, by name (E-EDID 1.4 table 3.21). */
export function dtdFieldProblems(d: DetailedTimingDescriptor): string[] {
  const fields: [keyof DetailedTimingDescriptor, string, number][] = [
    ["pixelClock10kHz", "pixel clock", 16],
    ["hActive", "horizontal active", 12],
    ["hBlank", "horizontal blanking", 12],
    ["vActive", "vertical active", 12],
    ["vBlank", "vertical blanking", 12],
    ["hFrontPorch", "horizontal front porch", 10],
    ["hSync", "horizontal sync width", 10],
    ["vFrontPorch", "vertical front porch", 6],
    ["vSync", "vertical sync width", 6],
  ];
  const problems = fields.flatMap(([key, name, bits]) => {
    const v = d[key] as number;
    const max = 2 ** bits - 1;
    if (key === "pixelClock10kHz" && v > max) return [`pixel clock ${fmtMHz(v * 10)} exceeds 655.35 MHz`];
    return v > max ? [`${name} ${v} exceeds ${max}`] : [];
  });
  if (problems.length === 0) {
    try {
      serializeDescriptor(d);
    } catch (e) {
      if (e instanceof EdidEncodeError) problems.push(e.message);
      else throw e;
    }
  }
  return problems;
}

function suggestionsFor(d: DetailedTimingDescriptor, fitsDisplayId: boolean): string[] {
  const out: string[] = [];
  if (fitsDisplayId) {
    out.push("This timing goes in a DisplayID extension block instead of a DTD; sources that ignore DisplayID use the fallback timing in the base block.");
  } else if (d.pixelClock10kHz > 65535) {
    out.push("Try reduced blanking, a lower refresh rate or a smaller raster.");
  }
  if (d.hFrontPorch > 1023 || d.hBlank > 4095 || d.vFrontPorch > 63) {
    out.push("Try reduced blanking (the exact-refresh or CVT-RB formulas), which keeps porches small.");
  }
  return out;
}

function requirePorches(req: TimingRequest): Porches {
  if (!req.porches) throw new EdidEncodeError("porches", "manual timing needs all six porch and sync values");
  return req.porches;
}

/** Default minimum porches for the exact solver: CVT-RB v1 horizontal (48/32/80, 160 blank) and CVT-RB v1 vertical minimums. */
export function exactDefaults(hActive: number, vActive: number, refresh: string | Rational): Porches {
  const rb = calcCvt(hActive, vActive, rationalHz(parseRefresh(refresh)), 1);
  return rb.porches;
}

/**
 * Exact-refresh solver (SPEC.md section 6). A DTD clock is a whole number of
 * 10 kHz steps, so refresh = clock / (hTotal x vTotal) is exact only for some
 * totals. Searches extra horizontal blanking (multiples of 8 first, then 2,
 * then 1) and extra vertical lines within the slack, keeps combinations that
 * are exact, and picks the one with the least added blanking.
 */
function solveExact(req: TimingRequest, refresh: Rational): { porches: Porches; clockKHz: number; exact: boolean } {
  const min = req.porches ?? exactDefaults(req.hActive, req.vActive, refresh);
  const slack = req.slack ?? { lines: 60, pixels: 64 };
  const hBase = req.hActive + min.hFrontPorch + min.hSync + min.hBackPorch;
  const vBase = req.vActive + min.vFrontPorch + min.vSync + min.vBackPorch;

  let best: { dh: number; dv: number; cost: number } | undefined;
  for (const step of [8, 2, 1]) {
    for (let dh = 0; dh <= slack.pixels; dh += step) {
      for (let dv = 0; dv <= slack.lines; dv++) {
        // Exact when hTotal * vTotal * num is divisible by den * 10000 (clock in 10 kHz units).
        const product = BigInt(hBase + dh) * BigInt(vBase + dv) * BigInt(refresh.num);
        if (product % (BigInt(refresh.den) * 10_000n) !== 0n) continue;
        const cost = dh * (vBase + dv) + dv * (hBase + dh);
        if (!best || cost < best.cost) best = { dh, dv, cost };
      }
    }
    if (best) break;
  }
  const dh = best?.dh ?? 0;
  const dv = best?.dv ?? 0;
  const porches = { ...min, hBackPorch: min.hBackPorch + dh, vBackPorch: min.vBackPorch + dv };
  const clockKHz = ((hBase + dh) * (vBase + dv) * refresh.num) / refresh.den / 1000;
  return { porches, clockKHz, exact: best !== undefined };
}

/**
 * CVT timing, ported from edid-decode calc_cvt_mode(). rb: 0 none, 1 RB v1,
 * 2 RB v2, 3 RB v3 (CVT 2.0, with its options). Progressive, no margins.
 */
export function calcCvt(hPixels: number, vLines: number, fps: number, rb: 0 | 1 | 2 | 3, rb3: Rb3Options = {}): { porches: Porches; clockKHz: number } {
  const CELL_GRAN = 8;
  const CVT_MIN_VSYNC_BP = 550;
  const CVT_MIN_V_PORCH = 3;
  const CVT_MIN_V_BPORCH = 7;
  const CVT_FIXED_V_BPORCH = 6;
  const CVT_C_PRIME = 30;
  const CVT_M_PRIME = 300;
  const CVT_RB_MIN_VBLANK = 460;
  const CVT_RB_ALT_MIN_VBLANK = 300;

  // RB v3 vertical blank: at least 300 us, nothing strictly between 440 and 460, at most 920.
  let rbVBlank = rb3.vBlankUs ?? CVT_RB_MIN_VBLANK;
  if (rb === 3) {
    if (rbVBlank < CVT_RB_ALT_MIN_VBLANK) rbVBlank = CVT_RB_ALT_MIN_VBLANK;
    else if (rbVBlank > CVT_RB_ALT_MIN_VBLANK + 140 && rbVBlank < CVT_RB_MIN_VBLANK) rbVBlank = CVT_RB_MIN_VBLANK;
    else if (rbVBlank > CVT_RB_MIN_VBLANK + 460) rbVBlank = CVT_RB_MIN_VBLANK + 460;
  }
  const rbMinVBlank = rb === 3 ? rbVBlank : CVT_RB_MIN_VBLANK;

  const cellGran = rb === 2 ? 1 : CELL_GRAN;
  const hPixelsRnd = Math.floor(hPixels / cellGran) * cellGran;
  const vLinesRnd = vLines;
  const totalActivePixels = hPixelsRnd;
  const clockStep = rb >= 2 ? 0.001 : 0.25;
  let hBlank = rb === 1 ? 160 : 80;
  if (rb === 3 && rb3.hBlank) hBlank = Math.min(200, Math.max(80, rb3.hBlank & ~7));
  const rbVFporch = rb === 1 ? 3 : 1;
  let hSync = 32;

  let vSync: number;
  if (Math.floor((vLines * 4) / 3) === hPixels) vSync = 4;
  else if (Math.floor((vLines * 16) / 9) === hPixels) vSync = 5;
  else if (Math.floor((vLines * 16) / 10) === hPixels) vSync = 6;
  else if (vLines % 4 === 0 && Math.floor((vLines * 5) / 4) === hPixels) vSync = 7;
  else if (Math.floor((vLines * 15) / 9) === hPixels) vSync = 7;
  else vSync = 10;
  if (rb >= 2) vSync = 8;

  let vBlank: number;
  let vSyncBp: number;
  let pixelFreq: number;
  if (rb === 0) {
    const hPeriodEst = ((1 / fps - CVT_MIN_VSYNC_BP / 1_000_000) / (vLinesRnd + CVT_MIN_V_PORCH)) * 1_000_000;
    vSyncBp = Math.floor(CVT_MIN_VSYNC_BP / hPeriodEst) + 1;
    if (vSyncBp < vSync + CVT_MIN_V_BPORCH) vSyncBp = vSync + CVT_MIN_V_BPORCH;
    vBlank = vSyncBp + CVT_MIN_V_PORCH;
    let idealDutyCycle = CVT_C_PRIME - (CVT_M_PRIME * hPeriodEst) / 1000;
    if (idealDutyCycle < 20) idealDutyCycle = 20;
    hBlank = Math.floor((totalActivePixels * idealDutyCycle) / (100 - idealDutyCycle) / (2 * CELL_GRAN)) * 2 * CELL_GRAN;
    const totalPixels = totalActivePixels + hBlank;
    hSync = Math.floor((totalPixels * 0.08) / CELL_GRAN) * CELL_GRAN;
    pixelFreq = Math.floor(totalPixels / hPeriodEst / clockStep) * clockStep;
  } else {
    const hPeriodEst = (1_000_000 / fps - rbMinVBlank) / vLinesRnd;
    const vbiLines = Math.floor(rbMinVBlank / hPeriodEst) + 1;
    let rbVBporch = rb === 1 ? CVT_MIN_V_BPORCH : CVT_FIXED_V_BPORCH;
    const rbMinVbi = rbVFporch + vSync + rbVBporch;
    vBlank = vbiLines < rbMinVbi ? rbMinVbi : vbiLines;
    const totalVLines = vBlank + vLinesRnd;
    if (rb === 3 && rb3.earlyVsync) {
      rbVBporch = Math.floor(vbiLines / 2);
      if (vBlank - rbVBporch - vSync < rbVFporch) rbVBporch = vBlank - vSync - rbVFporch;
    }
    vSyncBp = rb === 1 ? vBlank - rbVFporch : vSync + rbVBporch;
    const totalPixels = hBlank + totalActivePixels;
    const freq = fps * totalVLines * totalPixels;
    // RB v3 rounds the clock up so the refresh is never below the target.
    pixelFreq = (rb === 3 ? Math.ceil : Math.floor)(freq / 1_000_000 / clockStep) * clockStep;
  }

  const vBackPorch = vSyncBp - vSync;
  const vFrontPorch = vBlank - vBackPorch - vSync;
  const hFrontPorch = rb >= 2 ? 8 : hBlank / 2 - hSync;
  const hBackPorch = hBlank - hFrontPorch - hSync;
  // CVT works on the rounded width; the remainder becomes extra back porch so totals stay consistent.
  const widthLoss = hPixels - hPixelsRnd;
  return {
    porches: { hFrontPorch, hSync, hBackPorch: hBackPorch - widthLoss, vFrontPorch, vSync, vBackPorch },
    clockKHz: Math.round(1000 * pixelFreq),
  };
}

/**
 * GTF timing (VESA GTF 1.1, default curve C=40, M=600, K=128, J=20), ported
 * from edid-decode calc_gtf_mode() with the vertical rate as input.
 * Progressive, no margins. The front porch can come out negative for small
 * rasters (edid-decode: 292x176 at 76 Hz); the caller refuses that.
 */
export function calcGtf(hPixels: number, vLines: number, fps: number): { porches: Porches; clockKHz: number } {
  const CELL_GRAN = 8;
  const GTF_MIN_PORCH = 1;
  const GTF_V_SYNC_RQD = 3;
  const GTF_H_SYNC_PERC = 8;
  const GTF_MIN_VSYNC_BP = 550;
  const [C, M, K, J] = [40, 600, 128, 20];
  const cPrime = ((C - J) * K) / 256 + J;
  const mPrime = (K / 256) * M;

  const hPixelsRnd = Math.round(hPixels / CELL_GRAN) * CELL_GRAN;
  const hPeriodEst = ((1 / fps - GTF_MIN_VSYNC_BP / 1_000_000) / (vLines + GTF_MIN_PORCH)) * 1_000_000;
  const vSyncBp = Math.round(GTF_MIN_VSYNC_BP / hPeriodEst);
  const totalVLines = vLines + vSyncBp + GTF_MIN_PORCH;
  const vFieldRateEst = (1 / hPeriodEst / totalVLines) * 1_000_000;
  const hPeriod = hPeriodEst / (fps / vFieldRateEst);
  const idealDutyCycle = cPrime - (mPrime * hPeriod) / 1000;
  const hBlank = Math.round((hPixelsRnd * idealDutyCycle) / (100 - idealDutyCycle) / (2 * CELL_GRAN)) * 2 * CELL_GRAN;
  const totalPixels = hPixelsRnd + hBlank;
  const pixelFreq = totalPixels / hPeriod;
  const hSync = Math.round((GTF_H_SYNC_PERC / 100) * totalPixels / CELL_GRAN) * CELL_GRAN;
  const hFrontPorch = hBlank / 2 - hSync;
  // GTF works on the rounded width; the difference comes out of the back porch so totals stay consistent.
  const widthLoss = hPixels - hPixelsRnd;
  return {
    porches: { hFrontPorch, hSync, hBackPorch: hFrontPorch + hSync - widthLoss, vFrontPorch: GTF_MIN_PORCH, vSync: GTF_V_SYNC_RQD, vBackPorch: vSyncBp - GTF_V_SYNC_RQD },
    clockKHz: Math.round(1000 * pixelFreq),
  };
}

function fmtHz(hz: number): string {
  return Number.isInteger(hz) ? String(hz) : hz.toFixed(3);
}

export function fmtMHz(khz: number): string {
  return `${(khz / 1000).toFixed(khz % 10 === 0 ? 2 : 3)} MHz`;
}
