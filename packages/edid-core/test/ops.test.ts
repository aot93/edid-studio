import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addDetailedTiming,
  addDisplayIdTiming,
  buildTiming,
  displayIdTimings,
  validateEdid,
  EdidEncodeError,
  keepOnlyModes,
  makePreferred,
  setColor,
  importEdid,
  parseEdid,
  removeDataBlock,
  removeSvd,
  serializeEdid,
  setCtaYcbcr,
  setHdmiDeepColour,
  setHf420DeepColour,
  setMonitorName,
  setRangeLimits,
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

describe("timing operations", () => {
  const tessera = importEdid(readFileSync(join(CORPUS_DIR, "../fixtures/Tessera-EJE-test.txt"), "utf8")).edid;

  it("keepOnlyModes strips every mode and leaves the HDMI capabilities", () => {
    const out = keepOnlyModes(tessera);
    expect(out.base.establishedTimings).toEqual([0, 0, 0]);
    expect(out.base.standardTimings.every(([a, b]) => a === 1 && b === 1)).toBe(true);
    expect(out.base.descriptors.some((d) => d.kind === "dtd")).toBe(false);
    expect(cta(out).dataBlocks.map((b) => b.kind)).toEqual(["hdmiVsdb", "hdmiForumVsdb", "videoCapability"]);
    expect(cta(out).dataBlocks.find((b) => b.kind === "hdmiVsdb")).toMatchObject({ tail: [0x00] });
    roundTrips(out);
  });

  it("keepOnlyModes keeps listed VICs and their 4:2:0 flags", () => {
    const out = keepOnlyModes(tessera, { vics: [96, 16] });
    const vics = cta(out).dataBlocks.flatMap((b) => (b.kind === "video" ? b.svds.map((s) => s.vic) : []));
    expect(vics).toEqual([96, 16]);
    expect(cta(out).dataBlocks.find((b) => b.kind === "ycbcr420CapabilityMap")).toMatchObject({ bitmap: [0x01] });
    roundTrips(out);
  });

  it("makePreferred swaps a timing into slot 0, keeping the old preferred", () => {
    const dell = load("dell-p2415q-hdmi2.0");
    const ctaDtd = cta(dell).descriptors.findIndex((d) => d.kind === "dtd");
    const oldFirst = dell.base.descriptors[0];
    const target = cta(dell).descriptors[ctaDtd];
    const out = makePreferred(dell, { extension: 0, index: ctaDtd });
    expect(out.base.descriptors[0]).toEqual(target);
    expect(cta(out).descriptors[ctaDtd]).toEqual(oldFirst);
    roundTrips(out);
  });

  it("addDetailedTiming fills a dummy slot, then the CTA block", () => {
    const d = tessera.base.descriptors[0];
    if (d?.kind !== "dtd") throw new Error("no DTD");
    const once = addDetailedTiming(tessera, d);
    expect(once.base.descriptors[1]).toEqual(d);
    const twice = addDetailedTiming(once, d);
    expect(cta(twice).descriptors).toEqual([d]);
    roundTrips(twice);
  });

  it("setColor without 4:2:0 removes the 4:2:0 map and flags", () => {
    const out = setColor(tessera, ["rgb", "ycbcr444"], [8, 10]);
    expect(cta(out).dataBlocks.some((b) => b.kind === "ycbcr420CapabilityMap")).toBe(false);
    expect(cta(out).dataBlocks.find((b) => b.kind === "hdmiForumVsdb")).toMatchObject({ dc30bit420: false, dc36bit420: false });
    expect(cta(out).dataBlocks.find((b) => b.kind === "hdmiVsdb")).toMatchObject({ capabilities: { dc30bit: true, dc36bit: false, dcY444: true } });
    roundTrips(out);
  });
});

describe("addDisplayIdTiming", () => {
  const wide = buildTiming({ hActive: 5760, vActive: 1080, refresh: "60", formula: "exact" }).displayId;
  if (!wide) throw new Error("no DisplayID timing");

  it("adds a DisplayID block after the CTA block of an HDMI EDID 1.3, with an EEODB so sources read it", () => {
    const e = addDisplayIdTiming(load("dell-p2415q-hdmi2.0"), wide);
    expect(e.extensions.map((x) => x.kind)).toEqual(["cta", "displayid"]);
    expect(cta(e).dataBlocks[0]).toEqual({ kind: "raw", bytes: [0xe2, 0x78, 2] });
    expect(displayIdTimings(e).map((t) => [t.hActive, t.flags & 0x80])).toEqual([[5760, 0x80]]);
    expect(validateEdid(e).filter((i) => i.rule === "structure.block-map")).toEqual([]);
    roundTrips(e);
    expect(serializeEdid(e)[126]).toBe(1);
  });

  it("appends to an existing typed section and makes the new timing the only preferred one", () => {
    const once = addDisplayIdTiming(load("dell-p2415q-hdmi2.0"), wide);
    const twice = addDisplayIdTiming(once, { ...wide, hActive: 7680 });
    expect(twice.extensions.length).toBe(2);
    expect(displayIdTimings(twice).map((t) => [t.hActive, t.flags & 0x80])).toEqual([
      [5760, 0],
      [7680, 0x80],
    ]);
    roundTrips(twice);
  });

  it("updates an EEODB count already there instead of adding a second one", () => {
    const e = addDisplayIdTiming(load("dell-p2415q-hdmi2.0"), wide);
    const more = { ...e, extensions: [...e.extensions, { kind: "raw" as const, bytes: [0x10, ...new Array<number>(126).fill(0)] }] };
    const again = addDisplayIdTiming(more, wide);
    expect(cta(again).dataBlocks.filter((b) => b.kind === "raw" && b.bytes[1] === 0x78)).toEqual([{ kind: "raw", bytes: [0xe2, 0x78, 3] }]);
  });

  it("a single-block EDID gets a DisplayID block 1 and needs no EEODB", () => {
    const base = { ...load("dell-p2415q-hdmi2.0"), extensions: [] };
    const e = addDisplayIdTiming(base, wide);
    expect(e.extensions.map((x) => x.kind)).toEqual(["displayid"]);
    roundTrips(e);
  });
});

describe("range limits above 255", () => {
  const e13 = load("dell-p2415q-hdmi2.0");
  const rl = (e: Edid) => e.base.descriptors.find((d) => d.kind === "rangeLimits");

  it("EDID 1.4 stores them with the +255 offset flags (E-EDID 1.4 table 3.26)", () => {
    const e14 = { ...e13, base: { ...e13.base, revision: 4 } };
    const out = setRangeLimits(e14, { vHz: [24, 300], hKHz: [270, 280], maxClockMHz: 1200, gtf: "none" });
    expect(rl(out)).toMatchObject({ offsetFlags: 0x0e, minVerticalHz: 24, maxVerticalHz: 45, minHorizontalKHz: 15, maxHorizontalKHz: 25 });
    roundTrips(out);
    expect(() => setRangeLimits(e14, { vHz: [24, 511], hKHz: [30, 80], maxClockMHz: 600, gtf: "none" })).toThrow(/510/);
  });

  it("EDID 1.3 has no offsets: auto limits cap at 255, which edid-decode reads as 255 or more", () => {
    expect(() => setRangeLimits(e13, { vHz: [24, 60], hKHz: [30, 275], maxClockMHz: 600, gtf: "none" })).toThrow(/255/);
  });
});
