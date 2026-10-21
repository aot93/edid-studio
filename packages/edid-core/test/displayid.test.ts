// DisplayID extension blocks (tag 0x70) and Type I detailed timings, for
// rasters a DTD cannot hold. Layouts are checked against edid-decode
// parse-displayid-block.cpp and Linux drm_displayid.c / drm_edid.c.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  describeDisplayIdTiming,
  EdidEncodeError,
  parseDisplayIdExtension,
  parseEdid,
  preferredDisplayIdTiming,
  serializeDisplayIdExtension,
  serializeEdid,
} from "../src/index.ts";
import type { DisplayIdExtension, DisplayIdTiming } from "../src/index.ts";
import { CORPUS_DIR } from "./corpus.ts";

const corpus = (name: string) => new Uint8Array(readFileSync(join(CORPUS_DIR, "edid-decode", name)));

/** Every DisplayID extension block in the corpus, bytes 0 to 126. */
const corpusBlocks = readdirSync(join(CORPUS_DIR, "edid-decode"))
  .filter((f) => f !== "LICENSE")
  .flatMap((f) => {
    const b = corpus(f);
    const out: { name: string; block: number[] }[] = [];
    for (let i = 128; i + 128 <= b.length; i += 128) if (b[i] === 0x70) out.push({ name: `${f} block ${i / 128}`, block: [...b.slice(i, i + 127)] });
    return out;
  });

/** 5760x1080 at 60 Hz with CVT-RB v1 porches. */
const wide: DisplayIdTiming = {
  pixelClock10kHz: 39463,
  flags: 0x80,
  hActive: 5760,
  hBlank: 160,
  hFrontPorch: 48,
  hSync: 32,
  hSyncPositive: true,
  vActive: 1080,
  vBlank: 31,
  vFrontPorch: 3,
  vSync: 10,
  vSyncPositive: false,
};

const section = (timings: readonly DisplayIdTiming[]): DisplayIdExtension => ({
  kind: "displayid",
  version: 0x12,
  productType: 5,
  extensionCount: 0,
  dataBlocks: [{ kind: "type1Timings", revision: 0, timings }],
  filler: 0,
});

describe("DisplayID extension blocks", () => {
  it("round-trips every DisplayID block in the corpus byte for byte", () => {
    expect(corpusBlocks.length).toBeGreaterThan(30);
    for (const { name, block } of corpusBlocks) {
      const typed = parseDisplayIdExtension(block);
      if (typed) expect(serializeDisplayIdExtension(typed), name).toEqual(block);
    }
  });

  it("types nearly all of them, including zero filler inside the section", () => {
    const typed = corpusBlocks.filter(({ block }) => parseDisplayIdExtension(block) !== undefined);
    expect(typed.length / corpusBlocks.length).toBeGreaterThan(0.9);
  });

  it("decodes Type I timings as edid-decode does (dell-up2715k-dp-switchresx)", () => {
    const ext = parseEdid(corpus("dell-up2715k-dp-switchresx")).extensions[1];
    expect(ext?.kind).toBe("displayid");
    if (ext?.kind !== "displayid") return;
    expect([ext.version, ext.productType]).toEqual([0x11, 3]);
    const block = ext.dataBlocks[0];
    if (block?.kind !== "type1Timings") throw new Error("no Type I block");
    // edid-decode: 5120x2880 59.992864 Hz, 938.25 MHz, Hfront 48 Hsync 32 Hback 80 P, Vfront 3 Vsync 5 Vback 74 N.
    const t = block.timings[0];
    if (!t) throw new Error("no timing");
    expect(t).toMatchObject({ pixelClock10kHz: 93825, hActive: 5120, hFrontPorch: 48, hSync: 32, hSyncPositive: true, vActive: 2880, vFrontPorch: 3, vSync: 5, vSyncPositive: false });
    const info = describeDisplayIdTiming(t);
    expect([info.hBackPorch, info.vBackPorch]).toEqual([80, 74]);
    expect(info.refreshHz).toBeCloseTo(59.992864, 6);
    expect(ext.dataBlocks[1]?.kind).toBe("raw"); // GP ASCII string, kept raw
  });

  it("decodes the preferred flag (acer-xv273k-corrected_difdb: second timing preferred)", () => {
    const ext = parseEdid(corpus("acer-xv273k-corrected_difdb")).extensions[1];
    if (ext?.kind !== "displayid") throw new Error("not typed");
    const block = ext.dataBlocks.find((b) => b.kind === "type1Timings");
    if (block?.kind !== "type1Timings") throw new Error("no Type I block");
    expect(block.timings.map((t) => [t.hActive, t.pixelClock10kHz, (t.flags & 0x80) !== 0])).toEqual([
      [3840, 106651, false],
      [3840, 130475, true],
    ]);
    expect(preferredDisplayIdTiming(parseEdid(corpus("acer-xv273k-corrected_difdb")))?.pixelClock10kHz).toBe(130475);
  });

  it("reads bit 7 as preferred only below block revision 2, where it means YCbCr 4:2:0", () => {
    const edid = (revision: number) => ({ ...parseEdid(corpus("dell-up2715k-dp-switchresx")), extensions: [{ ...section([wide]), dataBlocks: [{ kind: "type1Timings" as const, revision, timings: [wide] }] }] });
    expect(preferredDisplayIdTiming(edid(0))).toEqual(wide);
    expect(preferredDisplayIdTiming(edid(2))).toBeUndefined();
  });

  it("stores each field minus one, little-endian, polarity in the porch's top bit (drm_mode_displayid_detailed)", () => {
    const b = serializeDisplayIdExtension(section([wide]));
    // Section header: tag, version 1.2, 23 bytes of data blocks, product type 5, no extensions.
    expect(b.slice(0, 5)).toEqual([0x70, 0x12, 23, 5, 0]);
    // Type I block header: tag 3, revision 0, 20 bytes.
    expect(b.slice(5, 8)).toEqual([0x03, 0x00, 20]);
    const t = b.slice(8, 28);
    const le = (i: number) => (t[i] ?? 0) | ((t[i + 1] ?? 0) << 8);
    expect((t[0] ?? 0) | ((t[1] ?? 0) << 8) | ((t[2] ?? 0) << 16)).toBe(39463 - 1);
    expect(t[3]).toBe(0x80);
    expect([le(4), le(6), le(8) & 0x7fff, le(10), le(12), le(14), le(16) & 0x7fff, le(18)]).toEqual([5759, 159, 47, 31, 1079, 30, 2, 9]);
    expect([(t[9] ?? 0) >> 7, (t[17] ?? 0) >> 7]).toEqual([1, 0]);
    // DisplayID checksum covers bytes 1 to 5 + length (drm validate_displayid()), then zero padding.
    expect(b.slice(1, 29).reduce((a, v) => a + v, 0) % 256).toBe(0);
    expect(b.slice(29).every((v) => v === 0)).toBe(true);
    expect(b.length).toBe(127);
  });

  it("round-trips a built section through a whole EDID", () => {
    expect(parseDisplayIdExtension(serializeDisplayIdExtension(section([wide])))).toEqual(section([wide]));
  });

  it("holds any raster up to 65536 x 65536 and refuses one pixel more, naming the field", () => {
    const max = { ...wide, hActive: 65536, vActive: 65536 };
    expect(parseDisplayIdExtension(serializeDisplayIdExtension(section([max])))).toEqual(section([max]));
    expect(() => serializeDisplayIdExtension(section([{ ...wide, hActive: 65537 }]))).toThrow(/horizontal active 65537 exceeds 65536/);
    expect(() => serializeDisplayIdExtension(section([{ ...wide, vFrontPorch: 32769 }]))).toThrow(/vertical front porch 32769 exceeds 32768/);
    expect(() => serializeDisplayIdExtension(section([{ ...wide, pixelClock10kHz: 2 ** 24 + 1 }]))).toThrow(EdidEncodeError);
    expect(() => serializeDisplayIdExtension(section([{ ...wide, hFrontPorch: 0 }]))).toThrow(/horizontal front porch 0 is below 1/);
  });

  it("refuses more timings than a section holds (121 bytes)", () => {
    expect(() => serializeDisplayIdExtension(section(new Array(5).fill(wide)))).not.toThrow();
    expect(() => serializeDisplayIdExtension(section(new Array(6).fill(wide)))).toThrow(/121/);
  });

  it("keeps a block raw when its section checksum is wrong, so nothing is silently repaired", () => {
    const b = serializeDisplayIdExtension(section([wide]));
    b[28] = ((b[28] ?? 0) + 1) & 0xff;
    expect(parseDisplayIdExtension(b)).toBeUndefined();
  });

  it("serializes a typed DisplayID block back into the whole EDID unchanged", () => {
    const bytes = corpus("dell-up2715k-dp-switchresx");
    expect(serializeEdid(parseEdid(bytes))).toEqual(bytes);
  });
});
