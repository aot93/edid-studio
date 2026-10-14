// 18-byte descriptors, shared by the base block and CTA-861 extensions.
// Layouts: VESA E-EDID 1.4, section 3.10; checked against edid-decode
// parse-base-block.cpp detailed_timings() and detailed_block().

import { byteAt, checkField, reencodes, slice } from "./bytes.ts";
import { EdidEncodeError } from "./errors.ts";
import type { Descriptor, DetailedTimingDescriptor, RangeLimitsDescriptor } from "./model.ts";

export const DESCRIPTOR_SIZE = 18;

/**
 * Parses an 18-byte descriptor. A descriptor whose typed form would not
 * re-encode to the same bytes is returned as `raw`.
 */
export function parseDescriptor(bytes: readonly number[]): Descriptor {
  if (bytes.length !== DESCRIPTOR_SIZE) {
    throw new RangeError(`descriptor is ${bytes.length} bytes, expected ${DESCRIPTOR_SIZE}`);
  }
  const typed = parseTyped(bytes);
  if (typed && reencodes(typed, serializeDescriptor, bytes)) return typed;
  return { kind: "raw", bytes: [...bytes] };
}

function parseTyped(x: readonly number[]): Descriptor | undefined {
  const b = (i: number) => byteAt(x, i);
  if (b(0) !== 0 || b(1) !== 0) return parseDtd(x);

  // Display descriptor: bytes 0-2 zero, byte 3 tag, byte 4 zero except on
  // range limits, where 1.4 uses it for rate offsets (E-EDID 1.4, 3.10.3).
  if (b(2) !== 0) return undefined;
  const tag = b(3);
  switch (tag) {
    case 0xfc:
    case 0xfe:
    case 0xff:
      return { kind: "text", tag, text: decodeText(slice(x, 5, 18)) };
    case 0xfd:
      return {
        kind: "rangeLimits",
        offsetFlags: b(4),
        minVerticalHz: b(5),
        maxVerticalHz: b(6),
        minHorizontalKHz: b(7),
        maxHorizontalKHz: b(8),
        maxPixelClock10MHz: b(9),
        timingSupport: b(10),
        timingData: slice(x, 11, 18),
      };
    case 0x10:
      return { kind: "dummy" };
    default:
      return undefined;
  }
}

/** E-EDID 1.4 table 3.21. */
function parseDtd(x: readonly number[]): DetailedTimingDescriptor {
  const b = (i: number) => byteAt(x, i);
  return {
    kind: "dtd",
    pixelClock10kHz: b(0) | (b(1) << 8),
    hActive: b(2) | ((b(4) & 0xf0) << 4),
    hBlank: b(3) | ((b(4) & 0x0f) << 8),
    vActive: b(5) | ((b(7) & 0xf0) << 4),
    vBlank: b(6) | ((b(7) & 0x0f) << 8),
    hFrontPorch: b(8) | ((b(11) & 0xc0) << 2),
    hSync: b(9) | ((b(11) & 0x30) << 4),
    vFrontPorch: (b(10) >> 4) | ((b(11) & 0x0c) << 2),
    vSync: (b(10) & 0x0f) | ((b(11) & 0x03) << 4),
    hImageMm: b(12) | ((b(14) & 0xf0) << 4),
    vImageMm: b(13) | ((b(14) & 0x0f) << 8),
    hBorder: b(15),
    vBorder: b(16),
    flags: b(17),
  };
}

/** Text payload: up to 13 bytes, ended by 0x0a and padded with 0x20 (E-EDID 1.4, 3.10.3.1). */
function decodeText(payload: readonly number[]): string {
  const end = payload.indexOf(0x0a);
  const chars = end === -1 ? payload : payload.slice(0, end);
  return String.fromCharCode(...chars);
}

function encodeText(text: string): number[] {
  if (text.length > 13) {
    throw new EdidEncodeError("text", `text "${text}" is ${text.length} characters; the limit is 13`);
  }
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) out.push(checkField("text character", text.charCodeAt(i), 8));
  if (out.length < 13) out.push(0x0a);
  while (out.length < 13) out.push(0x20);
  return out;
}

export function serializeDescriptor(d: Descriptor): number[] {
  switch (d.kind) {
    case "dtd":
      return serializeDtd(d);
    case "text":
      return [0, 0, 0, d.tag, 0, ...encodeText(d.text)];
    case "rangeLimits":
      return serializeRangeLimits(d);
    case "dummy":
      return [0, 0, 0, 0x10, ...new Array<number>(14).fill(0)];
    case "raw":
      if (d.bytes.length !== DESCRIPTOR_SIZE) {
        throw new EdidEncodeError("descriptor", `raw descriptor is ${d.bytes.length} bytes, expected ${DESCRIPTOR_SIZE}`);
      }
      return d.bytes.map((v) => checkField("descriptor byte", v, 8));
  }
}

function serializeDtd(d: DetailedTimingDescriptor): number[] {
  const clock = checkField("pixel clock", d.pixelClock10kHz, 16);
  if (clock === 0) {
    throw new EdidEncodeError("pixel clock", "pixel clock 0 is not allowed in a detailed timing descriptor");
  }
  const hActive = checkField("horizontal active", d.hActive, 12);
  const hBlank = checkField("horizontal blanking", d.hBlank, 12);
  const vActive = checkField("vertical active", d.vActive, 12);
  const vBlank = checkField("vertical blanking", d.vBlank, 12);
  const hfp = checkField("horizontal front porch", d.hFrontPorch, 10);
  const hSync = checkField("horizontal sync width", d.hSync, 10);
  const vfp = checkField("vertical front porch", d.vFrontPorch, 6);
  const vSync = checkField("vertical sync width", d.vSync, 6);
  const hMm = checkField("horizontal image size", d.hImageMm, 12);
  const vMm = checkField("vertical image size", d.vImageMm, 12);
  return [
    clock & 0xff,
    clock >> 8,
    hActive & 0xff,
    hBlank & 0xff,
    ((hActive >> 8) << 4) | (hBlank >> 8),
    vActive & 0xff,
    vBlank & 0xff,
    ((vActive >> 8) << 4) | (vBlank >> 8),
    hfp & 0xff,
    hSync & 0xff,
    ((vfp & 0x0f) << 4) | (vSync & 0x0f),
    ((hfp >> 8) << 6) | ((hSync >> 8) << 4) | ((vfp >> 4) << 2) | (vSync >> 4),
    hMm & 0xff,
    vMm & 0xff,
    ((hMm >> 8) << 4) | (vMm >> 8),
    checkField("horizontal border", d.hBorder, 8),
    checkField("vertical border", d.vBorder, 8),
    checkField("timing flags", d.flags, 8),
  ];
}

function serializeRangeLimits(d: RangeLimitsDescriptor): number[] {
  if (d.timingData.length !== 7) {
    throw new EdidEncodeError("range limits timing data", `range limits timing data is ${d.timingData.length} bytes, expected 7`);
  }
  return [
    0,
    0,
    0,
    0xfd,
    checkField("range limit offset flags", d.offsetFlags, 8),
    checkField("minimum vertical rate", d.minVerticalHz, 8),
    checkField("maximum vertical rate", d.maxVerticalHz, 8),
    checkField("minimum horizontal rate", d.minHorizontalKHz, 8),
    checkField("maximum horizontal rate", d.maxHorizontalKHz, 8),
    checkField("maximum pixel clock", d.maxPixelClock10MHz, 8),
    checkField("timing support flags", d.timingSupport, 8),
    ...d.timingData.map((v) => checkField("range limits timing data", v, 8)),
  ];
}

export type SyncType =
  | "analog-composite"
  | "bipolar-analog-composite"
  | "digital-composite"
  | "digital-separate";

export interface DtdFlags {
  readonly interlaced: boolean;
  /** Bits 6, 5 and 0. 0 means no stereo (bit 0 is then don't-care). */
  readonly stereoMode: number;
  readonly sync: SyncType;
  /** Digital sync only: horizontal polarity (bit 1). */
  readonly hSyncPositive: boolean;
  /** Digital separate sync only: vertical polarity (bit 2). */
  readonly vSyncPositive: boolean;
}

const SYNC_TYPES: readonly SyncType[] = [
  "analog-composite",
  "bipolar-analog-composite",
  "digital-composite",
  "digital-separate",
];

/** Decodes DTD byte 17 (E-EDID 1.4, table 3.22; edid-decode detailed_timings()). */
export function decodeDtdFlags(flags: number): DtdFlags {
  const sync = SYNC_TYPES[(flags >> 3) & 0x03] ?? "analog-composite";
  const digital = sync === "digital-composite" || sync === "digital-separate";
  return {
    interlaced: (flags & 0x80) !== 0,
    stereoMode: flags & 0x61,
    sync,
    hSyncPositive: digital && (flags & 0x02) !== 0,
    vSyncPositive: sync === "digital-separate" && (flags & 0x04) !== 0,
  };
}
