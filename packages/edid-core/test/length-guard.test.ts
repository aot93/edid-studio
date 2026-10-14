// Acceptance test 8: an export whose length is not 128 x (1 + extensions),
// or whose checksum is non-zero, is refused.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertExportable,
  EdidExportError,
  EdidParseError,
  formatHex,
  importEdid,
  parseEdid,
  serializeEdid,
} from "../src/index.ts";
import { CORPUS_DIR } from "./corpus.ts";

const twoBlocks = new Uint8Array(readFileSync(join(CORPUS_DIR, "edid-decode/dell-p2415q-hdmi2.0")));

describe("length guard", () => {
  it("starts from a sound 256-byte EDID", () => {
    expect(twoBlocks.length).toBe(256);
    expect(() => assertExportable(twoBlocks)).not.toThrow();
  });

  it("refuses a truncated 255-byte file on export", () => {
    expect(() => assertExportable(twoBlocks.subarray(0, 255))).toThrow(EdidExportError);
    expect(() => assertExportable(twoBlocks.subarray(0, 255))).toThrow(/255 bytes/);
  });

  it("refuses a truncated 255-byte hex file on import", () => {
    const text = formatHex(twoBlocks.subarray(0, 255));
    expect(() => importEdid(text)).toThrow(EdidParseError);
  });

  // The lengths hand-copying produced in the case study (SPEC.md, section 14).
  it.each([258, 335])("refuses %i bytes", (n) => {
    const padded = new Uint8Array(n);
    padded.set(twoBlocks.subarray(0, Math.min(n, 256)));
    expect(() => assertExportable(padded)).toThrow(EdidExportError);
    expect(() => parseEdid(padded)).toThrow(EdidParseError);
  });

  it("refuses a length that disagrees with the extension count", () => {
    const wrongCount = Uint8Array.from(twoBlocks);
    wrongCount[126] = 2;
    expect(() => assertExportable(wrongCount)).toThrow(/declares 2 extension block\(s\), so it must be 128 x \(1 \+ 2\) = 384 bytes/);
  });

  it("refuses a non-zero checksum and names the block", () => {
    const corrupt = Uint8Array.from(twoBlocks);
    corrupt[255] = ((corrupt[255] ?? 0) + 1) & 0xff;
    expect(() => assertExportable(corrupt)).toThrow(/block 1 checksum/);
  });

  it("imports a bad checksum for diagnosis, and export repairs it", () => {
    const corrupt = Uint8Array.from(twoBlocks);
    corrupt[127] = ((corrupt[127] ?? 0) + 1) & 0xff;
    const imported = importEdid(corrupt);
    expect(imported.checksumErrors).toHaveLength(1);
    expect(serializeEdid(imported.edid)).toEqual(twoBlocks);
  });

  it("refuses a missing header", () => {
    const noHeader = Uint8Array.from(twoBlocks);
    noHeader[0] = 0x01;
    expect(() => assertExportable(noHeader)).toThrow(/header/);
  });

  it("uses the HDMI Forum EEODB count instead of byte 126", () => {
    const eeodb = importEdid(readFileSync(join(CORPUS_DIR, "cta-eeodb.test"), "utf8"));
    expect(eeodb.bytes[126]).toBe(1);
    expect(eeodb.bytes.length).toBeGreaterThan(256);
    expect(() => assertExportable(eeodb.bytes)).not.toThrow();
    expect(serializeEdid(eeodb.edid)).toEqual(eeodb.bytes);
  });
});
