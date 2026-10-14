// Plain-language views of model nodes, shared by the UI and the CLI.

import { CTA_VIC_ROWS } from "./data/cta-vics.ts";
import { decodeDtdFlags } from "./descriptors.ts";
import type { DetailedTimingDescriptor } from "./model.ts";

export interface VideoMode {
  readonly hActive: number;
  /** Frame lines (both fields for interlaced modes). */
  readonly vActive: number;
  readonly interlaced: boolean;
  readonly pixelClockKHz: number;
  readonly hTotal: number;
  /** Frame or field rate in Hz. */
  readonly refreshHz: number;
  readonly hSyncPositive: boolean;
  readonly vSyncPositive: boolean;
}

export interface VicInfo extends VideoMode {
  readonly vic: number;
  readonly aspect: string;
}

const VICS = new Map(CTA_VIC_ROWS.map((r) => [r[0], r]));

/**
 * CTA-861 VIC lookup (table generated from edid-decode). Interlaced rates:
 * a field holds half the active lines plus the per-field blanking, plus half
 * a line; VIC 39 uses an even 1250-line frame.
 */
export function lookupVic(vic: number): VicInfo | undefined {
  const r = VICS.get(vic);
  if (r === undefined) return undefined;
  const [, hActive, vActive, ah, av, clk, il, hfp, hs, hbp, hp, vfp, vs, vbp, vp, even] = r;
  const hTotal = hActive + hfp + hs + hbp;
  const vBlank = vfp + vs + vbp;
  const lines = il ? vActive / 2 + vBlank + (even ? 0 : 0.5) : vActive + vBlank;
  return {
    vic,
    aspect: `${ah}:${av}`,
    hActive,
    vActive,
    interlaced: il === 1,
    pixelClockKHz: clk,
    hTotal,
    refreshHz: (clk * 1000) / (hTotal * lines),
    hSyncPositive: hp === 1,
    vSyncPositive: vp === 1,
  };
}

export interface DtdInfo extends VideoMode {
  readonly vTotal: number;
  readonly hBackPorch: number;
  readonly vBackPorch: number;
}

/** Totals, porches and refresh of a DTD. Blanking includes borders (edid-decode convention). */
export function describeDtd(d: DetailedTimingDescriptor): DtdInfo {
  const flags = decodeDtdFlags(d.flags);
  const hTotal = d.hActive + d.hBlank;
  const vTotal = d.vActive + d.vBlank;
  // TODO(verify): interlaced DTD field rate; the half line follows CTA practice.
  const lines = flags.interlaced ? vTotal + 0.5 : vTotal;
  return {
    hActive: d.hActive,
    vActive: flags.interlaced ? d.vActive * 2 : d.vActive,
    interlaced: flags.interlaced,
    pixelClockKHz: d.pixelClock10kHz * 10,
    hTotal,
    vTotal,
    hBackPorch: d.hBlank - 2 * d.hBorder - d.hFrontPorch - d.hSync,
    vBackPorch: d.vBlank - 2 * d.vBorder - d.vFrontPorch - d.vSync,
    refreshHz: (d.pixelClock10kHz * 10_000) / (hTotal * lines),
    hSyncPositive: flags.hSyncPositive,
    vSyncPositive: flags.vSyncPositive,
  };
}

/** "3840x2160 @ 50.000 Hz" or "1920x1080i @ 60.000 Hz". */
export function modeLabel(m: VideoMode): string {
  return `${m.hActive}x${m.vActive}${m.interlaced ? "i" : ""} @ ${m.refreshHz.toFixed(3)} Hz`;
}
