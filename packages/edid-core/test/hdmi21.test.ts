// HDMI 2.1 (M6): the HDMI Forum VSDB and SCDB in full (FRL, VRR, DSC and
// the HDMI 2.1 feature flags), FRL link budgets, and building HDMI 2.1 EDIDs.
// Layout: edid-decode parse-cta-block.cpp cta_hf_scdb(), case 0x779.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEdid, buildTiming, feasibility, FRL_RATES, frlRateFor, lookupVic, parseEdid, serializeEdid, validateEdid } from "../src/index.ts";
import type { CtaExtension, Edid, HdmiForumVsdb } from "../src/index.ts";
import { CORPUS_DIR } from "./corpus.ts";

const corpus = (f: string) => new Uint8Array(readFileSync(join(CORPUS_DIR, "edid-decode", f)));
const forum = (e: Edid): HdmiForumVsdb => {
  for (const x of e.extensions) {
    if (x.kind !== "cta") continue;
    const b = x.dataBlocks.find((d) => d.kind === "hdmiForumVsdb");
    if (b?.kind === "hdmiForumVsdb") return b;
  }
  throw new Error("no HDMI Forum block");
};
const cta = (e: Edid): CtaExtension => {
  const x = e.extensions.find((y) => y.kind === "cta");
  if (x?.kind !== "cta") throw new Error("no CTA");
  return x;
};

describe("HDMI Forum VSDB, all fields", () => {
  it("decodes the Samsung Q800T as edid-decode does: FRL 10x4, ALLM, DSC", () => {
    const f = forum(parseEdid(corpus("samsung-q800t-hdmi2.1")));
    expect(f).toMatchObject({ maxTmdsCharRate5MHz: 120, scdcPresent: true, maxFrlRate: 5, uhdVic: true, dc30bit420: true });
    expect(f.features21).toMatchObject({ allm: true, mDelta: false, qms: false });
    expect(f.vrr).toEqual({ min: 0, max: 0 });
    // DSC 1.2a, 4:2:0, 10 bpc; up to 8 slices at 340 MHz (code 4); DSC max FRL 6x4 (code 3); 12288 bytes of chunks (code 11).
    expect(f.dsc).toMatchObject({ dsc12a: true, native420: true, bpc10: true, bpc12: false, maxSlices: 4, maxFrlRate: 3, totalChunkKBytes: 11 });
  });

  it("decodes the LG C9: FRL 12x4, VRR 40-120 Hz, Mdelta, ALLM, no DSC", () => {
    const f = forum(parseEdid(corpus("lg-oled-c9-hdmi")));
    expect(f.maxFrlRate).toBe(6);
    expect(f.vrr).toEqual({ min: 40, max: 120 });
    expect(f.features21).toMatchObject({ mDelta: true, allm: true });
  });

  it("round-trips every HDMI Forum block in the corpus byte for byte", () => {
    for (const f of ["samsung-q800t-hdmi2.1", "samsung-q800t-hdmi2.1-game", "lg-oled-c9-hdmi", "dell-p2415q-hdmi2.0"]) {
      const bytes = corpus(f);
      expect(serializeEdid(parseEdid(bytes)), f).toEqual(bytes);
    }
  });

  it("writes the SCDB form (extended tag 0x79, two reserved bytes) and reads it back", () => {
    const base = parseEdid(corpus("lg-oled-c9-hdmi"));
    const scdb: Edid = {
      ...base,
      extensions: base.extensions.map((x) =>
        x.kind === "cta" ? { ...x, dataBlocks: x.dataBlocks.map((d) => (d.kind === "hdmiForumVsdb" ? { ...d, scdb: [0, 0] as const } : d)) } : x,
      ),
    };
    const bytes = serializeEdid(scdb);
    expect(parseEdid(bytes)).toEqual(scdb);
    const block = cta(scdb).dataBlocks.findIndex((d) => d.kind === "hdmiForumVsdb");
    expect(block).toBeGreaterThan(-1);
    // Header: extended tag (7) and length, then 0x79 and the two reserved bytes.
    const b = Array.from(bytes);
    const at = b.findIndex((v, i) => v >> 5 === 7 && b[i + 1] === 0x79 && i > 128);
    expect(b.slice(at + 1, at + 4)).toEqual([0x79, 0, 0]);
  });
});

describe("FRL link budget (HDMI 2.1)", () => {
  it("lists the six FRL rates, lanes x Gbps", () => {
    expect(FRL_RATES.map((r) => [r.code, r.lanes, r.gbpsPerLane])).toEqual([
      [1, 3, 3],
      [2, 3, 6],
      [3, 4, 6],
      [4, 4, 8],
      [5, 4, 10],
      [6, 4, 12],
    ]);
  });

  it("picks the lowest FRL rate whose payload (16b/18b) carries the stream", () => {
    // 4K60 10-bit RGB: 594 MHz x 30 bits = 17.82 Gbps; 6x3 carries 16, 6x4 carries 21.33.
    expect(frlRateFor(594_000 * 30)?.code).toBe(3);
    // 4K120 10-bit RGB: 1188 MHz x 30 = 35.64 Gbps; 10x4 carries 35.56, 12x4 42.67.
    expect(frlRateFor(1_188_000 * 30)?.code).toBe(6);
    expect(frlRateFor(1_188_000 * 48)).toBeUndefined();
  });

  it("HDMI 2.1: TMDS up to 600 MHz, FRL above, per format and depth", () => {
    const vic117 = lookupVic(117); // 4K120
    if (!vic117) throw new Error("VIC 117");
    const rows = feasibility(vic117.pixelClockKHz, "hdmi2.1");
    expect(rows.find((r) => r.format === "rgb" && r.depth === 10)).toMatchObject({ fits: true, frl: { code: 6 } });
    expect(rows.find((r) => r.format === "rgb" && r.depth === 16)).toMatchObject({ fits: false });
    const fourK60 = feasibility(594_000, "hdmi2.1").find((r) => r.format === "rgb" && r.depth === 8);
    expect(fourK60).toMatchObject({ fits: true, rateKHz: 594_000 });
    expect(fourK60?.frl).toBeUndefined();
  });
});

describe("building HDMI 2.1 EDIDs", () => {
  const timing = (w: number, h: number, hz: string) => {
    const r = buildTiming({ hActive: w, vActive: h, refresh: hz, formula: "exact" });
    if (!r.dtd) throw new Error(r.dtdProblems.join());
    return r.dtd;
  };
  const wide = (w: number, h: number, hz: string) => {
    const r = buildTiming({ hActive: w, vActive: h, refresh: hz, formula: "cvt-rb2" });
    if (!r.displayId) throw new Error(r.displayIdProblems.join());
    return r.displayId;
  };
  const intent = { name: "Wall", manufacturerId: "VYV", productCode: 1, year: 2026, link: "hdmi2.1", formats: ["rgb"], depths: [10] } as const;

  it("4K120 10-bit RGB (above a DTD's clock, so DisplayID): TMDS 600, SCDC, and the lowest FRL rate that carries it", () => {
    const t = wide(3840, 2160, "120");
    const e = buildEdid({ ...intent, timing: timing(1920, 1080, "120"), displayIdTimings: [t] });
    const f = forum(e);
    expect(f).toMatchObject({ maxTmdsCharRate5MHz: 120, scdcPresent: true, maxFrlRate: frlRateFor(t.pixelClock10kHz * 10 * 30)?.code });
    expect(f.maxFrlRate).toBeGreaterThanOrEqual(2);
    expect(validateEdid(e).filter((i) => i.severity === "error")).toEqual([]);
    expect(parseEdid(serializeEdid(e))).toEqual(e);
  });

  it("a mode within TMDS needs no FRL", () => {
    expect(forum(buildEdid({ ...intent, timing: timing(3840, 2160, "50") })).maxFrlRate).toBe(0);
  });

  it("refuses what even 48 Gbps FRL cannot carry", () => {
    expect(() => buildEdid({ ...intent, depths: [16], timing: timing(1920, 1080, "60"), displayIdTimings: [wide(3840, 2160, "144")] })).toThrow(/FRL/);
  });
});
