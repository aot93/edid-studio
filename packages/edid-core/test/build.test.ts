import { describe, expect, it } from "vitest";
import { buildEdid, buildTiming, encodeChromaticity, importEdid, parseEdid, serializeEdid, SRGB, structuralProblems, validateEdid } from "../src/index.ts";
import type { BuildIntent } from "../src/index.ts";

const timing = (w: number, h: number, hz: string) => {
  const r = buildTiming({ hActive: w, vActive: h, refresh: hz, formula: "exact" });
  if (!r.dtd) throw new Error(r.dtdProblems.join("; "));
  return r.dtd;
};

const intent: BuildIntent = {
  name: "LED wall",
  manufacturerId: "EDS",
  productCode: 1,
  year: 2026,
  timing: timing(3840, 2160, "50"),
  link: "hdmi2.0",
  formats: ["rgb"],
  depths: [8, 10],
};

describe("encodeChromaticity", () => {
  it("encodes sRGB to the bytes real EDIDs carry (ee 91 a3 54 4c 99 26 0f 50 54)", () => {
    expect(encodeChromaticity(SRGB)).toEqual([0xee, 0x91, 0xa3, 0x54, 0x4c, 0x99, 0x26, 0x0f, 0x50, 0x54]);
  });
});

describe("buildEdid", () => {
  it("builds a sound two-block EDID that round-trips", () => {
    const edid = buildEdid(intent);
    const bytes = serializeEdid(edid);
    expect(bytes.length).toBe(256);
    expect(structuralProblems(bytes)).toEqual([]);
    expect(parseEdid(bytes)).toEqual(edid);
  });

  it("is reproducible: same intent, same bytes", () => {
    expect(serializeEdid(buildEdid(intent))).toEqual(serializeEdid(buildEdid(intent)));
  });

  it("declares exactly what was asked: 10-bit, RGB only, SCDC for a 555 MHz mode, no VICs", () => {
    const edid = buildEdid(intent);
    const cta = edid.extensions[0];
    if (cta?.kind !== "cta") throw new Error("no CTA");
    expect(cta).toMatchObject({ ycbcr444: false, ycbcr422: false });
    expect(cta.dataBlocks.find((b) => b.kind === "hdmiVsdb")).toMatchObject({ capabilities: { dc30bit: true, dc36bit: false, dc48bit: false, dcY444: false }, maxTmdsClock5MHz: 68 });
    expect(cta.dataBlocks.find((b) => b.kind === "hdmiForumVsdb")).toMatchObject({ scdcPresent: true, maxTmdsCharRate5MHz: 120 });
    expect(cta.dataBlocks.some((b) => b.kind === "video")).toBe(false);
    // EDID 1.3 as HDMI requires: digital input, no depth field there.
    expect([edid.base.version, edid.base.revision, edid.base.videoInput]).toEqual([1, 3, 0x80]);
    // No 640x480 unless asked for: the only mode is the one requested.
    expect(edid.base.establishedTimings).toEqual([0, 0, 0]);
    expect(edid.base.descriptors.map((d) => d.kind)).toEqual(["dtd", "rangeLimits", "text", "dummy"]);
  });

  it("adds 640x480 @ 60 Hz only on request, and widens the range limits to cover it", () => {
    const edid = buildEdid({ ...intent, include640x480: true });
    expect(edid.base.establishedTimings).toEqual([0x20, 0, 0]);
    expect(edid.base.descriptors.find((d) => d.kind === "rangeLimits")).toMatchObject({ minVerticalHz: 50, maxVerticalHz: 60, minHorizontalKHz: 31 });
    const plain = buildEdid(intent);
    expect(plain.base.descriptors.find((d) => d.kind === "rangeLimits")).toMatchObject({ minVerticalHz: 50, maxVerticalHz: 50, minHorizontalKHz: 110 });
  });

  it("leaves out the HDMI Forum VSDB when 340 MHz is enough", () => {
    const edid = buildEdid({ ...intent, timing: timing(1920, 1080, "60"), depths: [8] });
    const cta = edid.extensions[0];
    expect(cta?.kind === "cta" && cta.dataBlocks.map((b) => b.kind)).toEqual(["hdmiVsdb", "videoCapability"]);
  });

  it("refuses what the link cannot carry or the model cannot say", () => {
    expect(() => buildEdid({ ...intent, link: "hdmi1.4" })).toThrow(/340 MHz/);
    expect(() => buildEdid({ ...intent, link: "dvi" })).toThrow(/DVI/);
    expect(() => buildEdid({ ...intent, formats: ["rgb", "ycbcr420"] })).toThrow(/4:2:0/);
    expect(() => buildEdid({ ...intent, manufacturerId: "e1" })).toThrow(/manufacturer/);
    // 4:2:2 shares chroma between pixel pairs: an odd width cannot carry it (SPEC.md section 6).
    expect(() => buildEdid({ ...intent, formats: ["rgb", "ycbcr422"], timing: timing(3839, 2160, "50") })).toThrow(/3839 is odd/);
  });

  it("a DVI EDID is a single block", () => {
    const bytes = serializeEdid(buildEdid({ ...intent, link: "dvi", timing: timing(1920, 1080, "60"), depths: [8] }));
    expect(bytes.length).toBe(128);
    expect(importEdid(bytes).checksumErrors).toEqual([]);
  });

  describe("with a DisplayID timing for a raster a DTD cannot hold (5760x1080)", () => {
    const wide = buildTiming({ hActive: 5760, vActive: 1080, refresh: "60", formula: "exact" });
    const fallback = timing(1920, 1080, "60");
    if (!wide.displayId) throw new Error(wide.displayIdProblems.join("; "));
    const hdmi = buildEdid({ ...intent, depths: [8], timing: fallback, displayIdTimings: [wide.displayId] });

    it("HDMI: base, CTA and DisplayID; byte 126 is 1 and an EEODB first in block 1 declares 2 (EDID 1.3 with three blocks)", () => {
      const bytes = serializeEdid(hdmi);
      expect(bytes.length).toBe(384);
      expect(bytes[126]).toBe(1);
      expect(structuralProblems(bytes)).toEqual([]);
      expect(parseEdid(bytes)).toEqual(hdmi);
      expect(hdmi.extensions.map((e) => e.kind)).toEqual(["cta", "displayid"]);
      const cta = hdmi.extensions[0];
      if (cta?.kind !== "cta") throw new Error("no CTA");
      // HDMI Forum EEODB: extended tag 0x78, one byte, the extension count (edid-decode cta_hf_eeodb()).
      expect(cta.dataBlocks[0]).toEqual({ kind: "raw", bytes: [0xe2, 0x78, 2] });
      expect([hdmi.base.version, hdmi.base.revision]).toEqual([1, 3]);
    });

    it("the DisplayID timing is preferred, the base block keeps the fallback", () => {
      const id = hdmi.extensions[1];
      if (id?.kind !== "displayid") throw new Error("no DisplayID");
      expect(id).toMatchObject({ version: 0x12, productType: 5, extensionCount: 0 });
      const block = id.dataBlocks[0];
      expect(block?.kind === "type1Timings" && block.timings.map((t) => [t.hActive, t.vActive, t.flags & 0x80])).toEqual([[5760, 1080, 0x80]]);
      expect(hdmi.base.descriptors[0]).toEqual(fallback);
    });

    it("TMDS rate, SCDC and range limits cover the DisplayID timing", () => {
      const cta = hdmi.extensions[0];
      if (cta?.kind !== "cta") throw new Error("no CTA");
      expect(wide.timing.pixelClock10kHz * 10).toBeGreaterThan(340_000);
      expect(cta.dataBlocks.find((b) => b.kind === "hdmiForumVsdb")).toMatchObject({ scdcPresent: true });
      const range = hdmi.base.descriptors.find((d) => d.kind === "rangeLimits");
      expect(range?.kind === "rangeLimits" && range.maxPixelClock10MHz * 10_000).toBeGreaterThanOrEqual(wide.timing.pixelClock10kHz * 10);
      expect(validateEdid(hdmi).filter((i) => i.severity === "error")).toEqual([]);
    });

    it("DVI: base and DisplayID only, two blocks, no EEODB", () => {
      const slow = buildTiming({ hActive: 5760, vActive: 1080, refresh: "24", formula: "cvt-rb2" }).displayId;
      if (!slow) throw new Error("no DisplayID timing");
      const dvi = buildEdid({ ...intent, link: "dvi", depths: [8], timing: timing(1920, 1080, "24"), displayIdTimings: [slow] });
      const bytes = serializeEdid(dvi);
      expect(bytes.length).toBe(256);
      expect(bytes[126]).toBe(1);
      expect(dvi.extensions.map((e) => e.kind)).toEqual(["displayid"]);
      expect(parseEdid(bytes)).toEqual(dvi);
    });
  });
});
