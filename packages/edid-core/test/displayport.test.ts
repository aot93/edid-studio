// DisplayPort: link budgets for HBR2, HBR3 and UHBR, and EDID 1.4 sinks
// that state depth, interface and colour formats in the base block
// (E-EDID 1.4 tables 3.11 and 3.14; edid-decode parse_base_block()).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { advertisedColour, buildEdid, buildTiming, defaultLink, feasibility, LINKS, parseEdid, serializeEdid, setColor, validateBytes, validateEdid } from "../src/index.ts";
import type { BuildIntent } from "../src/index.ts";
import { CORPUS_DIR } from "./corpus.ts";

const corpus = (f: string) => parseEdid(new Uint8Array(readFileSync(join(CORPUS_DIR, "edid-decode", f))));
const dtd = (w: number, h: number, hz: string) => {
  const r = buildTiming({ hActive: w, vActive: h, refresh: hz, formula: "cvt-rb2" });
  if (!r.dtd) throw new Error(r.dtdProblems.join());
  return r.dtd;
};
const intent: BuildIntent = { name: "DP wall", manufacturerId: "VYV", productCode: 1, year: 2026, timing: dtd(3840, 2160, "60"), link: "dp1.4", formats: ["rgb"], depths: [10] };

describe("DisplayPort links", () => {
  it("payloads: 8b/10b for HBR2 and HBR3, 128b/132b for UHBR, four lanes", () => {
    const gbps = (l: keyof typeof LINKS) => (LINKS[l].payloadKbps ?? 0) / 1_000_000;
    expect(gbps("dp1.2")).toBeCloseTo(17.28, 2);
    expect(gbps("dp1.4")).toBeCloseTo(25.92, 2);
    expect(gbps("dp2.1-uhbr10")).toBeCloseTo(38.79, 2);
    expect(gbps("dp2.1-uhbr13.5")).toBeCloseTo(52.36, 2);
    expect(gbps("dp2.1-uhbr20")).toBeCloseTo(77.58, 2);
  });

  it("needs pixel clock x bits per pixel: 3 x depth, 2 x depth for 4:2:2, 1.5 x depth for 4:2:0", () => {
    const at = (clock: number, f: string, d: number) => feasibility(clock, "dp1.4").find((r) => r.format === f && r.depth === d);
    // 4K60 CVT-RB v2, 522.6 MHz: 10-bit RGB is 15.68 Gbps, 16-bit RGB 25.08 Gbps, both inside 25.92.
    expect(at(522_614, "rgb", 10)).toMatchObject({ fits: true, kbps: 522_614 * 30 });
    expect(at(522_614, "rgb", 16)).toMatchObject({ fits: true });
    // 4K120, about 1.07 GHz: 10-bit RGB needs 32 Gbps; 10-bit 4:2:2 (21.4 Gbps) fits.
    expect(at(1_067_000, "rgb", 10)).toMatchObject({ fits: false });
    expect(at(1_067_000, "ycbcr422", 10)).toMatchObject({ fits: true, kbps: 1_067_000 * 20 });
    expect(at(1_067_000, "ycbcr420", 10)).toMatchObject({ kbps: 1_067_000 * 15 });
  });
});

describe("reading DisplayPort EDIDs", () => {
  it("takes depth and YCbCr support from the EDID 1.4 base block", () => {
    const e = corpus("acer-xb321hk-dp");
    expect(e.base.videoInput & 0x0f).toBe(0x05);
    const adv = advertisedColour(e);
    const bits = ((e.base.videoInput & 0x70) >> 3) + 4;
    expect(Math.max(...adv.depths)).toBe(bits);
    expect(adv.formats.includes("ycbcr444")).toBe((e.base.features & 0x08) !== 0);
  });

  it("defaults the link to DisplayPort for a DisplayPort EDID and to HDMI 2.0 otherwise", () => {
    expect(defaultLink(corpus("acer-xb321hk-dp"))).toBe("dp1.4");
    expect(defaultLink(corpus("dell-p2415q-hdmi2.0"))).toBe("hdmi2.0");
  });
});

describe("building DisplayPort EDIDs", () => {
  it("4K60 10-bit RGB: EDID 1.4, 10 bits and the DisplayPort interface in byte 20, no extension", () => {
    const e = buildEdid(intent);
    expect([e.base.version, e.base.revision]).toEqual([1, 4]);
    expect(e.base.videoInput).toBe(0x80 | (3 << 4) | 0x05);
    expect(e.base.features & 0x18).toBe(0);
    expect(e.extensions).toEqual([]);
    expect(advertisedColour(e).depths).toEqual([8, 10]);
    expect(parseEdid(serializeEdid(e))).toEqual(e);
    expect(validateEdid(e).filter((i) => i.severity !== "info")).toEqual([]);
  });

  it("states YCbCr 4:4:4 and 4:2:2 in byte 24 (bits 3 and 4)", () => {
    const e = buildEdid({ ...intent, formats: ["rgb", "ycbcr444", "ycbcr422"] });
    expect(e.base.features & 0x18).toBe(0x18);
    expect(advertisedColour(e).formats).toEqual(["rgb", "ycbcr444", "ycbcr422"]);
  });

  it("setColor on a DisplayPort EDID changes byte 20 depth and byte 24 formats", () => {
    const e = setColor(buildEdid(intent), ["rgb", "ycbcr444"], [12]);
    expect((e.base.videoInput & 0x70) >> 4).toBe(4);
    expect(e.base.features & 0x18).toBe(0x08);
  });

  it("a raster too large for a DTD goes in DisplayID: two blocks, no EEODB on EDID 1.4", () => {
    const wide = buildTiming({ hActive: 7680, vActive: 2160, refresh: "60", formula: "cvt-rb2" }).displayId;
    if (!wide) throw new Error("no DisplayID timing");
    const e = buildEdid({ ...intent, link: "dp2.1-uhbr20", timing: dtd(1920, 1080, "60"), displayIdTimings: [wide] });
    expect(e.extensions.map((x) => x.kind)).toEqual(["displayid"]);
    const bytes = serializeEdid(e);
    expect([bytes.length, bytes[126]]).toEqual([256, 1]);
    expect(validateBytes(bytes, { link: "dp2.1-uhbr20" }).errors).toBe(0);
  });

  it("refuses 4:2:0 and what the link cannot carry", () => {
    expect(() => buildEdid({ ...intent, formats: ["rgb", "ycbcr420"] })).toThrow(/4:2:0/);
    const fast = buildTiming({ hActive: 3840, vActive: 2160, refresh: "144", formula: "cvt-rb2" }).displayId;
    if (!fast) throw new Error("no timing");
    expect(() => buildEdid({ ...intent, link: "dp1.2", timing: dtd(1920, 1080, "60"), displayIdTimings: [fast] })).toThrow(/DisplayPort 1\.2/);
  });
});
