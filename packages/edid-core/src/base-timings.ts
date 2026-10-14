// Established and standard timings in the base block (E-EDID 1.4 sections
// 3.8 and 3.9; edid-decode parse-base-block.cpp established_timings12 and
// print_standard_timing()).

import { EdidEncodeError } from "./errors.ts";
import type { StandardTimingCode } from "./model.ts";

export interface EstablishedTiming {
  /** Byte offset in block 0 (0x23 to 0x25) and bit (7 is the most significant). */
  readonly byte: 0x23 | 0x24 | 0x25;
  readonly bit: number;
  readonly label: string;
  readonly refreshHz: number;
  readonly hKHz: number;
  readonly clockKHz: number;
}

/**
 * Bit order and rates from edid-decode --list-established-timings (byte 0x23
 * bit 7 first). Columns: byte, bit, label, refresh Hz, line rate kHz, pixel
 * clock kHz. Rates matter for automatic range limits.
 */
const ESTABLISHED_ROWS: readonly (readonly [number, number, string, number, number, number])[] = [
  [0x23, 7, "720x400 @ 70 Hz", 70.081663, 31.467, 28320],
  [0x23, 6, "720x400 @ 88 Hz", 87.849542, 39.444, 35500],
  [0x23, 5, "640x480 @ 60 Hz", 59.940476, 31.469, 25175],
  [0x23, 4, "640x480 @ 67 Hz", 66.666667, 35.000, 30240],
  [0x23, 3, "640x480 @ 72 Hz", 72.808802, 37.861, 31500],
  [0x23, 2, "640x480 @ 75 Hz", 75.000000, 37.500, 31500],
  [0x23, 1, "800x600 @ 56 Hz", 56.250000, 35.156, 36000],
  [0x23, 0, "800x600 @ 60 Hz", 60.316541, 37.879, 40000],
  [0x24, 7, "800x600 @ 72 Hz", 72.187572, 48.077, 50000],
  [0x24, 6, "800x600 @ 75 Hz", 75.000000, 46.875, 49500],
  [0x24, 5, "832x624 @ 75 Hz", 74.551266, 49.726, 57284],
  [0x24, 4, "1024x768i @ 87 Hz", 86.957532, 35.522, 44900],
  [0x24, 3, "1024x768 @ 60 Hz", 60.003840, 48.363, 65000],
  [0x24, 2, "1024x768 @ 70 Hz", 70.069359, 56.476, 75000],
  [0x24, 1, "1024x768 @ 75 Hz", 75.028582, 60.023, 78750],
  [0x24, 0, "1280x1024 @ 75 Hz", 75.024675, 79.976, 135000],
  [0x25, 7, "1152x870 @ 75 Hz", 75.061550, 68.681, 100000],
];

export const ESTABLISHED_TIMINGS: readonly EstablishedTiming[] = ESTABLISHED_ROWS.map(([byte, bit, label, refreshHz, hKHz, clockKHz]) => ({
  byte: byte as 0x23 | 0x24 | 0x25,
  bit,
  label,
  refreshHz,
  hKHz,
  clockKHz,
}));

export function isEstablishedSet(bytes: readonly [number, number, number], t: EstablishedTiming): boolean {
  return (((bytes[t.byte - 0x23] ?? 0) >> t.bit) & 1) === 1;
}

export type StandardAspect = "16:10" | "4:3" | "5:4" | "16:9";

const ASPECTS: readonly StandardAspect[] = ["16:10", "4:3", "5:4", "16:9"];
const RATIO: Record<StandardAspect, readonly [number, number]> = { "16:10": [16, 10], "4:3": [4, 3], "5:4": [5, 4], "16:9": [16, 9] };

export interface StandardTiming {
  readonly hActive: number;
  readonly vActive: number;
  readonly aspect: StandardAspect;
  readonly refreshHz: number;
}

/**
 * Decodes a standard timing; undefined for an unused slot (01 01, or a
 * first byte of 0 or 1). Aspect code 00 is 16:10 from EDID 1.3 on (1:1
 * before), which this tool treats as 16:10.
 */
export function decodeStandardTiming(code: StandardTimingCode): StandardTiming | undefined {
  const [b1, b2] = code;
  if (b1 <= 0x01) return undefined;
  const hActive = (b1 + 31) * 8;
  const aspect = ASPECTS[(b2 >> 6) & 0x03] ?? "16:10";
  const [h, v] = RATIO[aspect];
  return { hActive, vActive: Math.floor((hActive * v) / h), aspect, refreshHz: (b2 & 0x3f) + 60 };
}

export const UNUSED_STANDARD_TIMING: StandardTimingCode = [0x01, 0x01];

/** Encodes a standard timing: width 256 to 2288 in steps of 8, refresh 60 to 123 Hz. */
export function encodeStandardTiming(t: { readonly hActive: number; readonly aspect: StandardAspect; readonly refreshHz: number }): StandardTimingCode {
  if (!Number.isInteger(t.hActive) || t.hActive % 8 !== 0 || t.hActive < 256 || t.hActive > 2288) {
    throw new EdidEncodeError("standard timing width", `standard timing width ${t.hActive} must be a multiple of 8 from 256 to 2288`);
  }
  if (!Number.isInteger(t.refreshHz) || t.refreshHz < 60 || t.refreshHz > 123) {
    throw new EdidEncodeError("standard timing refresh", `standard timing refresh ${t.refreshHz} must be a whole number from 60 to 123 Hz`);
  }
  return [t.hActive / 8 - 31, (ASPECTS.indexOf(t.aspect) << 6) | (t.refreshHz - 60)];
}

export function standardTimingLabel(t: StandardTiming): string {
  return `${t.hActive}x${t.vActive} @ ${t.refreshHz} Hz (${t.aspect})`;
}
