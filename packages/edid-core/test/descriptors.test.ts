import { describe, expect, it } from "vitest";
import { decodeDtdFlags, EdidEncodeError, parseDescriptor, serializeDescriptor } from "../src/index.ts";
import type { DetailedTimingDescriptor } from "../src/index.ts";

// The working Tessera SX40 DTD, from SPEC.md section 9 ("expect.dtd").
const TESSERA_DTD = [0x70, 0xad, 0x00, 0xa0, 0xf0, 0x70, 0x3c, 0x80, 0x30, 0x20, 0x8a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1a];

describe("detailed timing descriptor", () => {
  it("decodes the case-study 4K50 timing", () => {
    const d = parseDescriptor(TESSERA_DTD);
    expect(d).toEqual({
      kind: "dtd",
      pixelClock10kHz: 44400,
      hActive: 3840,
      hBlank: 160,
      vActive: 2160,
      vBlank: 60,
      hFrontPorch: 48,
      hSync: 32,
      vFrontPorch: 8,
      vSync: 10,
      hImageMm: 0,
      vImageMm: 0,
      hBorder: 0,
      vBorder: 0,
      flags: 0x1a,
    });
    expect(decodeDtdFlags(0x1a)).toMatchObject({ interlaced: false, sync: "digital-separate", hSyncPositive: true, vSyncPositive: false });
  });

  it("encodes it back to the same 18 bytes", () => {
    expect(serializeDescriptor(parseDescriptor(TESSERA_DTD))).toEqual(TESSERA_DTD);
  });

  // Field widths: E-EDID 1.4 table 3.21 (SPEC.md section 6).
  const base = parseDescriptor(TESSERA_DTD) as DetailedTimingDescriptor;
  const limits: [keyof DetailedTimingDescriptor, string, number][] = [
    ["pixelClock10kHz", "pixel clock", 65535],
    ["hActive", "horizontal active", 4095],
    ["hBlank", "horizontal blanking", 4095],
    ["vActive", "vertical active", 4095],
    ["vBlank", "vertical blanking", 4095],
    ["hFrontPorch", "horizontal front porch", 1023],
    ["hSync", "horizontal sync width", 1023],
    ["vFrontPorch", "vertical front porch", 63],
    ["vSync", "vertical sync width", 63],
    ["hImageMm", "horizontal image size", 4095],
    ["vImageMm", "vertical image size", 4095],
  ];
  for (const [key, name, max] of limits) {
    it(`${name}: ${max} round-trips, ${max + 1} is refused by name`, () => {
      const atMax = { ...base, [key]: max };
      expect(parseDescriptor(serializeDescriptor(atMax))).toEqual(atMax);
      expect(() => serializeDescriptor({ ...base, [key]: max + 1 })).toThrow(`${name} ${max + 1} exceeds ${max}`);
    });
  }

  it("names the field for the VIC 96 front porch", () => {
    expect(() => serializeDescriptor({ ...base, hFrontPorch: 1056 })).toThrow("horizontal front porch 1056 exceeds 1023");
  });

  it("refuses a zero pixel clock", () => {
    expect(() => serializeDescriptor({ ...base, pixelClock10kHz: 0 })).toThrow(EdidEncodeError);
  });
});

describe("display descriptors", () => {
  const name = [0, 0, 0, 0xfc, 0, ...[..."Tessera SX40"].map((c) => c.charCodeAt(0)), 0x0a];

  it("decodes a monitor name", () => {
    expect(parseDescriptor(name)).toEqual({ kind: "text", tag: 0xfc, text: "Tessera SX40" });
  });

  it("pads short names with 0x0a then spaces", () => {
    const bytes = serializeDescriptor({ kind: "text", tag: 0xfc, text: "SX40" });
    expect(bytes.slice(5)).toEqual([0x53, 0x58, 0x34, 0x30, 0x0a, ...new Array<number>(8).fill(0x20)]);
  });

  it("refuses names over 13 characters", () => {
    expect(() => serializeDescriptor({ kind: "text", tag: 0xfc, text: "Fourteen chars" })).toThrow(/limit is 13/);
  });

  it("keeps non-standard padding byte for byte", () => {
    const zeroPadded = [0, 0, 0, 0xfc, 0, 0x41, 0x0a, ...new Array<number>(11).fill(0)];
    expect(parseDescriptor(zeroPadded)).toEqual({ kind: "raw", bytes: zeroPadded });
    expect(serializeDescriptor(parseDescriptor(zeroPadded))).toEqual(zeroPadded);
  });
});
