import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EdidEncodeError,
  importEdid,
  parseEdid,
  removeDataBlock,
  removeSvd,
  serializeEdid,
  setCtaYcbcr,
  setHdmiDeepColour,
  setHf420DeepColour,
  setMonitorName,
} from "../src/index.ts";
import type { CtaExtension, Edid } from "../src/index.ts";
import { CORPUS_DIR } from "./corpus.ts";

const load = (f: string) => importEdid(new Uint8Array(readFileSync(join(CORPUS_DIR, "edid-decode", f)))).edid;
const cta = (e: Edid): CtaExtension => {
  const x = e.extensions[0];
  if (x?.kind !== "cta") throw new Error("no CTA");
  return x;
};
const roundTrips = (e: Edid) => expect(parseEdid(serializeEdid(e))).toEqual(e);

const dell = load("dell-p2415q-hdmi2.0");
// LG C9: has a 4:2:0 capability map and an HDMI Forum VSDB.
const lg = load("lg-oled-c9-hdmi");

describe("setMonitorName", () => {
  it("replaces the name and changes nothing else in block 0 but the checksum", () => {
    const out = setMonitorName(dell, "Tessera SX40");
    expect(out.base.descriptors.find((d) => d.kind === "text" && d.tag === 0xfc)).toEqual({ kind: "text", tag: 0xfc, text: "Tessera SX40" });
    roundTrips(out);
    expect(out.extensions).toBe(dell.extensions);
  });

  it.each(["", "Fourteen chars", "café", "a\u001bb"])("refuses %j", (name) => {
    expect(() => setMonitorName(dell, name)).toThrow(EdidEncodeError);
  });

  it("leaves the input untouched", () => {
    const before = JSON.stringify(dell);
    setMonitorName(dell, "X");
    expect(JSON.stringify(dell)).toBe(before);
  });
});

describe("colour flags", () => {
  it("sets HDMI deep colour", () => {
    const out = setHdmiDeepColour(dell, { dc30bit: true, dc36bit: false });
    const vsdb = cta(out).dataBlocks.find((b) => b.kind === "hdmiVsdb");
    expect(vsdb?.kind === "hdmiVsdb" && vsdb.capabilities).toMatchObject({ dc30bit: true, dc36bit: false });
    roundTrips(out);
  });

  it("sets HDMI Forum 4:2:0 deep colour", () => {
    const out = setHf420DeepColour(lg, { dc36bit420: false, dc30bit420: true });
    const hf = cta(out).dataBlocks.find((b) => b.kind === "hdmiForumVsdb");
    expect(hf).toMatchObject({ dc36bit420: false, dc30bit420: true });
    roundTrips(out);
  });

  it("clears YCbCr support", () => {
    const out = setCtaYcbcr(dell, { ycbcr444: false, ycbcr422: false });
    expect(cta(out)).toMatchObject({ ycbcr444: false, ycbcr422: false });
    roundTrips(out);
  });
});

describe("removing modes", () => {
  const vdbIndex = cta(lg).dataBlocks.findIndex((b) => b.kind === "video");
  const vdb = cta(lg).dataBlocks[vdbIndex];
  const map = cta(lg).dataBlocks.find((b) => b.kind === "ycbcr420CapabilityMap");
  const svds = vdb?.kind === "video" ? vdb.svds : [];

  /** VICs flagged 4:2:0-capable by the map, as a set. */
  const y420Vics = (e: Edid): number[] => {
    const all = cta(e).dataBlocks.flatMap((b) => (b.kind === "video" ? b.svds : []));
    const m = cta(e).dataBlocks.find((b) => b.kind === "ycbcr420CapabilityMap");
    if (m?.kind !== "ycbcr420CapabilityMap") return [];
    return all.filter((_, i) => ((m.bitmap[i >> 3] ?? 0) >> (i & 7)) & 1).map((s) => s.vic).sort((a, b) => a - b);
  };

  it("has a map to test against", () => {
    expect(map?.kind).toBe("ycbcr420CapabilityMap");
    expect(y420Vics(lg).length).toBeGreaterThan(0);
  });

  it("removing each SVD keeps the 4:2:0 map on the same VICs", () => {
    svds.forEach((removed, i) => {
      const out = removeSvd(lg, 0, vdbIndex, i);
      const expected = y420Vics(lg).filter((v) => v !== removed.vic || svds.filter((s) => s.vic === v).length > 1);
      expect(y420Vics(out)).toEqual(expected);
      roundTrips(out);
    });
  });

  it("removing the whole video data block drops the map too", () => {
    const out = removeDataBlock(lg, 0, vdbIndex);
    expect(cta(out).dataBlocks.some((b) => b.kind === "video" || b.kind === "ycbcr420CapabilityMap")).toBe(false);
    roundTrips(out);
  });

  it("removes a non-video block by index", () => {
    const i = cta(dell).dataBlocks.findIndex((b) => b.kind === "hdmiForumVsdb");
    const out = removeDataBlock(dell, 0, i);
    expect(cta(out).dataBlocks.some((b) => b.kind === "hdmiForumVsdb")).toBe(false);
    expect(cta(out).dataBlocks).toHaveLength(cta(dell).dataBlocks.length - 1);
    roundTrips(out);
  });
});
