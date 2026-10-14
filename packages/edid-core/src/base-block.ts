// EDID base block. Layout: VESA E-EDID 1.4, section 3, table 3.1; checked
// against edid-decode parse-base-block.cpp parse_base_block().

import { BLOCK_SIZE, byteAt, checkField, slice } from "./bytes.ts";
import { DESCRIPTOR_SIZE, parseDescriptor, serializeDescriptor } from "./descriptors.ts";
import { EdidEncodeError } from "./errors.ts";
import type { BaseBlock, StandardTimingCode } from "./model.ts";

export const EDID_HEADER: readonly number[] = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];

const DESCRIPTORS_START = 0x36;

/** Parses bytes 0 to 125 of block 0. The header must already have been checked. */
export function parseBaseBlock(x: readonly number[]): BaseBlock {
  const b = (i: number) => byteAt(x, i);
  const standardTimings: StandardTimingCode[] = [];
  for (let i = 0x26; i < 0x36; i += 2) standardTimings.push([b(i), b(i + 1)]);
  const descriptors = [];
  for (let i = 0; i < 4; i++) {
    const start = DESCRIPTORS_START + i * DESCRIPTOR_SIZE;
    descriptors.push(parseDescriptor(slice(x, start, start + DESCRIPTOR_SIZE)));
  }
  return {
    manufacturerCode: (b(0x08) << 8) | b(0x09),
    productCode: b(0x0a) | (b(0x0b) << 8),
    serialNumber: (b(0x0c) | (b(0x0d) << 8) | (b(0x0e) << 16) | (b(0x0f) << 24)) >>> 0,
    week: b(0x10),
    yearOffset: b(0x11),
    version: b(0x12),
    revision: b(0x13),
    videoInput: b(0x14),
    screenSize: [b(0x15), b(0x16)],
    gamma: b(0x17),
    features: b(0x18),
    chromaticity: slice(x, 0x19, 0x23),
    establishedTimings: [b(0x23), b(0x24), b(0x25)],
    standardTimings,
    descriptors,
  };
}

/**
 * Writes bytes 0 to 125 of block 0. The caller adds byte 126 (extension
 * count) and byte 127 (checksum).
 */
export function serializeBaseBlock(base: BaseBlock): number[] {
  const u8 = (field: string, v: number) => checkField(field, v, 8);
  const product = checkField("product code", base.productCode, 16);
  const serial = checkField("serial number", base.serialNumber, 32);
  const manufacturer = checkField("manufacturer ID", base.manufacturerCode, 16);
  if (base.chromaticity.length !== 10) {
    throw new EdidEncodeError("chromaticity", `chromaticity is ${base.chromaticity.length} bytes, expected 10`);
  }
  if (base.standardTimings.length !== 8) {
    throw new EdidEncodeError("standard timings", `${base.standardTimings.length} standard timings, expected 8`);
  }
  if (base.descriptors.length !== 4) {
    throw new EdidEncodeError("descriptors", `${base.descriptors.length} base block descriptors, expected 4`);
  }
  const out = [
    ...EDID_HEADER,
    manufacturer >> 8,
    manufacturer & 0xff,
    product & 0xff,
    product >> 8,
    serial & 0xff,
    (serial >>> 8) & 0xff,
    (serial >>> 16) & 0xff,
    serial >>> 24,
    u8("week of manufacture", base.week),
    u8("year of manufacture", base.yearOffset),
    u8("EDID version", base.version),
    u8("EDID revision", base.revision),
    u8("video input definition", base.videoInput),
    u8("horizontal screen size", base.screenSize[0]),
    u8("vertical screen size", base.screenSize[1]),
    u8("gamma", base.gamma),
    u8("feature support", base.features),
    ...base.chromaticity.map((v) => u8("chromaticity", v)),
    ...base.establishedTimings.map((v) => u8("established timings", v)),
    ...base.standardTimings.flatMap(([a, c]) => [u8("standard timing", a), u8("standard timing", c)]),
    ...base.descriptors.flatMap(serializeDescriptor),
  ];
  if (out.length !== BLOCK_SIZE - 2) {
    throw new Error(`internal: base block serialized to ${out.length} bytes, expected 126`);
  }
  return out;
}

/**
 * Three-letter manufacturer ID from bytes 8-9: bit 15 reserved, then three
 * 5-bit letters where 1 is "A" (E-EDID 1.4, section 3.4.1). Codes outside
 * 1-26 decode as "?".
 */
export function manufacturerId(code: number): string {
  const letter = (v: number) => (v >= 1 && v <= 26 ? String.fromCharCode(64 + v) : "?");
  return letter((code >> 10) & 0x1f) + letter((code >> 5) & 0x1f) + letter(code & 0x1f);
}

export function encodeManufacturerId(id: string): number {
  if (!/^[A-Z]{3}$/.test(id)) {
    throw new EdidEncodeError("manufacturer ID", `manufacturer ID "${id}" must be three letters A to Z`);
  }
  const v = (i: number) => id.charCodeAt(i) - 64;
  return (v(0) << 10) | (v(1) << 5) | v(2);
}
