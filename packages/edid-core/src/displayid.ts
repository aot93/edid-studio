// DisplayID sections in EDID extension blocks (tag 0x70) and Type I detailed
// timings, which carry rasters a DTD cannot: 16-bit active and blanking,
// 24-bit clock. Layouts are checked against edid-decode
// parse-displayid-block.cpp (parse_displayid_block(), displayid_block(),
// parse_displayid_type_1_7_timing()) and Linux drm_displayid.c
// (validate_displayid()) and drm_edid.c (drm_mode_displayid_detailed()).
// TODO(verify): against the VESA DisplayID 1.3 text, section 2 and 4.4.

import { byteAt, reencodes, slice } from "./bytes.ts";
import type { DtdInfo } from "./describe.ts";
import { EdidEncodeError } from "./errors.ts";
import type { DisplayIdDataBlock, DisplayIdExtension, DisplayIdTiming, Edid } from "./model.ts";

export const DISPLAYID_EXTENSION_TAG = 0x70;

/** Data block tag: Video Timing Modes Type 1, Detailed Timings (DisplayID 1.3 table 4-1). */
const TAG_TYPE1_TIMINGS = 0x03;

/** Bytes per Type I timing descriptor. */
const TYPE1_SIZE = 20;

/** Most data block bytes a section in an EDID extension holds: 127 - 5 header - 1 checksum. */
export const MAX_SECTION_LENGTH = 121;

/** Version 1.2 (byte 1), the version most EDID-embedded sections use. */
export const DISPLAYID_VERSION = 0x12;

/**
 * Product type 5, repeater/translator. edid-decode requires a Display
 * Parameters block for display types (2, 3, 4, 6) and fails type 0 in the
 * first section; a Display Parameters aspect byte cannot hold wide rasters
 * such as 5760x1080. TODO(verify): NVIDIA drivers accept type 5 sections.
 */
export const PRODUCT_TYPE_REPEATER = 5;

/** Preferred-timing flag in Type I byte 3 (block revision below 2). */
export const TYPE1_PREFERRED = 0x80;

/**
 * Parses a DisplayID extension block (bytes 0 to 126). Returns undefined when
 * the block is not DisplayID, is malformed, or its typed form would not
 * re-encode to the same bytes (a wrong section checksum, non-zero padding);
 * the caller then keeps it raw.
 */
export function parseDisplayIdExtension(block: readonly number[]): DisplayIdExtension | undefined {
  const b = (i: number) => byteAt(block, i);
  if (b(0) !== DISPLAYID_EXTENSION_TAG) return undefined;
  const length = b(2);
  if (length > MAX_SECTION_LENGTH) return undefined;

  const dataBlocks: DisplayIdDataBlock[] = [];
  const end = 5 + length;
  let i = 5;
  // Same walk as edid-decode parse_displayid_block(): stop at fewer than three
  // bytes or a zero tag with zero length; what is left must be zero filler.
  while (end - i >= 3 && !(b(i) === 0 && b(i + 2) === 0)) {
    const next = i + 3 + b(i + 2);
    if (next > end) return undefined;
    dataBlocks.push(parseDataBlock(slice(block, i, next)));
    i = next;
  }

  const ext: DisplayIdExtension = {
    kind: "displayid",
    version: b(1),
    productType: b(3),
    extensionCount: b(4),
    dataBlocks,
    filler: end - i,
  };
  return reencodes(ext, serializeDisplayIdExtension, block.slice(0, 127)) ? ext : undefined;
}

function parseDataBlock(bytes: readonly number[]): DisplayIdDataBlock {
  const payload = bytes.slice(3);
  if (byteAt(bytes, 0) === TAG_TYPE1_TIMINGS && payload.length % TYPE1_SIZE === 0) {
    const timings: DisplayIdTiming[] = [];
    for (let i = 0; i < payload.length; i += TYPE1_SIZE) timings.push(decodeType1(payload.slice(i, i + TYPE1_SIZE)));
    return { kind: "type1Timings", revision: byteAt(bytes, 1), timings };
  }
  return { kind: "raw", bytes: [...bytes] };
}

function decodeType1(x: readonly number[]): DisplayIdTiming {
  const b = (i: number) => byteAt(x, i);
  const le = (i: number) => b(i) | (b(i + 1) << 8);
  return {
    pixelClock10kHz: (b(0) | (b(1) << 8) | (b(2) << 16)) + 1,
    flags: b(3),
    hActive: le(4) + 1,
    hBlank: le(6) + 1,
    hFrontPorch: (le(8) & 0x7fff) + 1,
    hSyncPositive: (b(9) & 0x80) !== 0,
    hSync: le(10) + 1,
    vActive: le(12) + 1,
    vBlank: le(14) + 1,
    vFrontPorch: (le(16) & 0x7fff) + 1,
    vSyncPositive: (b(17) & 0x80) !== 0,
    vSync: le(18) + 1,
  };
}

/** Writes bytes 0 to 126 of a DisplayID extension block; the caller appends the block checksum. */
export function serializeDisplayIdExtension(ext: DisplayIdExtension): number[] {
  const data = [...ext.dataBlocks.flatMap(serializeDisplayIdDataBlock), ...new Array<number>(checkRange("DisplayID filler", ext.filler, 0, MAX_SECTION_LENGTH)).fill(0)];
  if (data.length > MAX_SECTION_LENGTH) {
    throw new EdidEncodeError("DisplayID section length", `DisplayID data blocks take ${data.length} bytes; a section in an EDID block holds ${MAX_SECTION_LENGTH}`);
  }
  const section = [
    checkRange("DisplayID version", ext.version, 0, 0xff),
    data.length,
    checkRange("DisplayID product type", ext.productType, 0, 0xff),
    checkRange("DisplayID extension count", ext.extensionCount, 0, 0xff),
    ...data,
  ];
  const sum = section.reduce((a, v) => a + v, 0);
  const out = [DISPLAYID_EXTENSION_TAG, ...section, (256 - (sum % 256)) % 256];
  while (out.length < 127) out.push(0);
  return out;
}

export function serializeDisplayIdDataBlock(block: DisplayIdDataBlock): number[] {
  if (block.kind === "raw") {
    const bytes = block.bytes.map((v) => checkRange("DisplayID data block byte", v, 0, 0xff));
    if (bytes.length < 3 || byteAt(bytes, 2) !== bytes.length - 3) {
      throw new EdidEncodeError("DisplayID data block length", `DisplayID data block length byte does not match its ${bytes.length} bytes`);
    }
    return bytes;
  }
  const payload = block.timings.flatMap(encodeType1);
  if (payload.length > 0xff) throw new EdidEncodeError("DisplayID data block length", `${block.timings.length} timings exceed one data block`);
  return [TAG_TYPE1_TIMINGS, checkRange("DisplayID block revision", block.revision, 0, 0xff), payload.length, ...payload];
}

function encodeType1(t: DisplayIdTiming): number[] {
  const clock = checkRange("pixel clock (10 kHz units)", t.pixelClock10kHz, 1, 2 ** 24) - 1;
  const u16 = (name: string, v: number) => {
    const s = checkRange(name, v, 1, 0x10000) - 1;
    return [s & 0xff, s >> 8];
  };
  const porch = (name: string, v: number, positive: boolean) => {
    const s = checkRange(name, v, 1, 0x8000) - 1;
    return [s & 0xff, (s >> 8) | (positive ? 0x80 : 0)];
  };
  return [
    clock & 0xff,
    (clock >> 8) & 0xff,
    clock >> 16,
    checkRange("DisplayID timing options", t.flags, 0, 0xff),
    ...u16("horizontal active", t.hActive),
    ...u16("horizontal blanking", t.hBlank),
    ...porch("horizontal front porch", t.hFrontPorch, t.hSyncPositive),
    ...u16("horizontal sync width", t.hSync),
    ...u16("vertical active", t.vActive),
    ...u16("vertical blanking", t.vBlank),
    ...porch("vertical front porch", t.vFrontPorch, t.vSyncPositive),
    ...u16("vertical sync width", t.vSync),
  ];
}

function checkRange(field: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value)) throw new EdidEncodeError(field, `${field} ${value} is not a whole number`);
  if (value < min) throw new EdidEncodeError(field, `${field} ${value} is below ${min}`);
  if (value > max) throw new EdidEncodeError(field, `${field} ${value} exceeds ${max}`);
  return value;
}

/** Every Type I field that is out of range, by name. Empty when the timing encodes. */
export function displayIdTimingProblems(t: DisplayIdTiming): string[] {
  try {
    encodeType1(t);
  } catch (e) {
    if (e instanceof EdidEncodeError) return [e.message];
    throw e;
  }
  const problems: string[] = [];
  if (t.hFrontPorch + t.hSync > t.hBlank) problems.push(`horizontal front porch and sync (${t.hFrontPorch + t.hSync}) exceed the blanking (${t.hBlank})`);
  if (t.vFrontPorch + t.vSync > t.vBlank) problems.push(`vertical front porch and sync (${t.vFrontPorch + t.vSync}) exceed the blanking (${t.vBlank})`);
  return problems;
}

/** Totals, porches and refresh of a Type I timing. */
export function describeDisplayIdTiming(t: DisplayIdTiming): DtdInfo {
  const hTotal = t.hActive + t.hBlank;
  const vTotal = t.vActive + t.vBlank;
  // TODO(verify): interlaced Type I timings; edid-decode halves the vertical porches, so vActive is the frame.
  return {
    hActive: t.hActive,
    vActive: t.vActive,
    interlaced: (t.flags & 0x10) !== 0,
    pixelClockKHz: t.pixelClock10kHz * 10,
    hTotal,
    vTotal,
    hBackPorch: t.hBlank - t.hFrontPorch - t.hSync,
    vBackPorch: t.vBlank - t.vFrontPorch - t.vSync,
    refreshHz: (t.pixelClock10kHz * 10_000) / (hTotal * vTotal),
    hSyncPositive: t.hSyncPositive,
    vSyncPositive: t.vSyncPositive,
  };
}

/** Every Type I timing in the EDID's typed DisplayID sections, in order. */
export function displayIdTimings(edid: Edid): DisplayIdTiming[] {
  return edid.extensions.flatMap((e) =>
    e.kind === "displayid" ? e.dataBlocks.flatMap((b) => (b.kind === "type1Timings" ? b.timings : [])) : [],
  );
}

/**
 * The first preferred Type I timing. Byte 3 bit 7 means preferred only below
 * block revision 2 (edid-decode parse_displayid_type_1_7_timing()).
 */
export function preferredDisplayIdTiming(edid: Edid): DisplayIdTiming | undefined {
  for (const e of edid.extensions) {
    if (e.kind !== "displayid") continue;
    for (const b of e.dataBlocks) {
      if (b.kind !== "type1Timings" || (b.revision & 0x07) >= 2) continue;
      const t = b.timings.find((x) => x.flags & TYPE1_PREFERRED);
      if (t) return t;
    }
  }
  return undefined;
}

/** A DisplayID section holding these Type I timings, the first preferred unless `preferred: false`. */
export function displayIdSection(timings: readonly DisplayIdTiming[], options: { readonly preferred?: boolean } = {}): DisplayIdExtension {
  const preferred = options.preferred ?? true;
  return {
    kind: "displayid",
    version: DISPLAYID_VERSION,
    productType: PRODUCT_TYPE_REPEATER,
    extensionCount: 0,
    dataBlocks: [
      {
        kind: "type1Timings",
        revision: 0,
        timings: timings.map((t, i) => ({ ...t, flags: i === 0 && preferred ? t.flags | TYPE1_PREFERRED : t.flags & ~TYPE1_PREFERRED })),
      },
    ],
    filler: 0,
  };
}
