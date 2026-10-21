// Timing engine: turns "width x height at a refresh rate" into an exact,
// encodable timing, or says precisely why it cannot (SPEC.md section 6).
//
// CVT, CVT-RB v1 and CVT-RB v2 are ported from edid-decode
// calc-gtf-cvt.cpp calc_cvt_mode() (MIT), progressive and without margins.
// Known-answer tests compare against edid-decode --cvt.

import { serializeDescriptor } from "./descriptors.ts";
import { displayIdTimingProblems } from "./displayid.ts";
import { EdidEncodeError } from "./errors.ts";
import type { DetailedTimingDescriptor, DisplayIdTiming } from "./model.ts";

/** Largest active size any encoding here holds: DisplayID Type I's 16 bits, stored minus one. */
export const MAX_ACTIVE = 65536;

/** A refresh rate as an exact fraction, so 59.94 Hz can be 60000/1001. */
export interface Rational {
  readonly num: number;
  readonly den: number;
}

export type Formula = "manual" | "exact" | "cvt" | "cvt-rb" | "cvt-rb2";

export const FORMULA_NAMES: Record<Formula, string> = {
  exact: "Exact refresh (HDMI-safe RB)",
  "cvt-rb": "CVT reduced blanking v1",
  "cvt-rb2": "CVT reduced blanking v2",
  cvt: "CVT",
  manual: "Manual porches",
};

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
  const rb = req.formula !== "cvt";
  const hPos = req.hSyncPositive ?? rb;
  const vPos = req.vSyncPositive ?? !rb;

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
    default: {
      const cvt = calcCvt(req.hActive, req.vActive, rationalHz(refresh), req.formula === "cvt" ? 0 : req.formula === "cvt-rb" ? 1 : 2);
      porches = cvt.porches;
      clockKHz = cvt.clockKHz;
      if (req.hActive % 8 !== 0 && req.formula !== "cvt-rb2") notes.push(`CVT rounds the width down to a multiple of 8; ${req.hActive} is not one.`);
    }
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
  if (rb && porches.hFrontPorch + porches.hSync + porches.hBackPorch < 160) {
    notes.push("Horizontal blanking under 160 pixels is not generally HDMI-safe (a heuristic, not a spec limit).");
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
  if (dtdProblems.length > 0) notes.push(...suggestionsFor(candidate, displayIdProblems.length === 0));

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
 * CVT 1.2 timing, ported from edid-decode calc_cvt_mode(). rb: 0 none,
 * 1 RB v1, 2 RB v2. Progressive, no margins.
 */
export function calcCvt(hPixels: number, vLines: number, fps: number, rb: 0 | 1 | 2): { porches: Porches; clockKHz: number } {
  const CELL_GRAN = 8;
  const CVT_MIN_VSYNC_BP = 550;
  const CVT_MIN_V_PORCH = 3;
  const CVT_MIN_V_BPORCH = 7;
  const CVT_FIXED_V_BPORCH = 6;
  const CVT_C_PRIME = 30;
  const CVT_M_PRIME = 300;
  const CVT_RB_MIN_VBLANK = 460;

  const cellGran = rb === 2 ? 1 : CELL_GRAN;
  const hPixelsRnd = Math.floor(hPixels / cellGran) * cellGran;
  const vLinesRnd = vLines;
  const totalActivePixels = hPixelsRnd;
  const clockStep = rb >= 2 ? 0.001 : 0.25;
  let hBlank = rb === 1 ? 160 : 80;
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
    const hPeriodEst = (1_000_000 / fps - CVT_RB_MIN_VBLANK) / vLinesRnd;
    const vbiLines = Math.floor(CVT_RB_MIN_VBLANK / hPeriodEst) + 1;
    const rbVBporch = rb === 1 ? CVT_MIN_V_BPORCH : CVT_FIXED_V_BPORCH;
    const rbMinVbi = rbVFporch + vSync + rbVBporch;
    vBlank = vbiLines < rbMinVbi ? rbMinVbi : vbiLines;
    const totalVLines = vBlank + vLinesRnd;
    vSyncBp = rb === 1 ? vBlank - rbVFporch : vSync + rbVBporch;
    const totalPixels = hBlank + totalActivePixels;
    const freq = fps * totalVLines * totalPixels;
    pixelFreq = Math.floor(freq / 1_000_000 / clockStep) * clockStep;
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

function fmtHz(hz: number): string {
  return Number.isInteger(hz) ? String(hz) : hz.toFixed(3);
}

export function fmtMHz(khz: number): string {
  return `${(khz / 1000).toFixed(khz % 10 === 0 ? 2 : 3)} MHz`;
}
