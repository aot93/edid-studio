import { describe, expect, it } from "vitest";
import { buildEdid, buildTiming, encodeChromaticity, importEdid, parseEdid, serializeEdid, SRGB, structuralProblems } from "../src/index.ts";
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
    expect(edid.base.establishedTimings).toEqual([0x20, 0, 0]);
    expect(edid.base.descriptors.map((d) => d.kind)).toEqual(["dtd", "rangeLimits", "text", "dummy"]);
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
  });

  it("a DVI EDID is a single block", () => {
    const bytes = serializeEdid(buildEdid({ ...intent, link: "dvi", timing: timing(1920, 1080, "60"), depths: [8] }));
    expect(bytes.length).toBe(128);
    expect(importEdid(bytes).checksumErrors).toEqual([]);
  });
});
