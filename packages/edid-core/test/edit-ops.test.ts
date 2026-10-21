// Operations from SPEC.md section 9 added for the CLI and recipes:
// setIdentity, setSerial, setHdmiCaps, setAudio, stripAudio, addMode,
// removeMode. Each must leave an EDID that serializes and round-trips.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addMode,
  buildEdid,
  buildTiming,
  displayIdTimings,
  EdidEncodeError,
  importEdid,
  manufacturerId,
  parseEdid,
  removeMode,
  serializeEdid,
  setAudio,
  setHdmiCaps,
  setIdentity,
  setSerial,
  stripAudio,
  validateEdid,
} from "../src/index.ts";
import type { CtaExtension, Edid } from "../src/index.ts";
import { CORPUS_DIR, FIXTURES_DIR } from "./corpus.ts";

const load = (f: string) => importEdid(new Uint8Array(readFileSync(join(CORPUS_DIR, "edid-decode", f)))).edid;
const tessera = () => importEdid(readFileSync(join(FIXTURES_DIR, "Tessera-EJE-test.txt"), "utf8")).edid;
const cta = (e: Edid): CtaExtension => {
  const x = e.extensions.find((y) => y.kind === "cta");
  if (x?.kind !== "cta") throw new Error("no CTA");
  return x;
};
const roundTrips = (e: Edid) => expect(parseEdid(serializeEdid(e))).toEqual(e);
const dtd = (w: number, h: number, hz: string) => {
  const r = buildTiming({ hActive: w, vActive: h, refresh: hz, formula: "exact" });
  if (!r.dtd) throw new Error(r.dtdProblems.join());
  return r.dtd;
};
const built = buildEdid({
  name: "LED wall",
  manufacturerId: "VYV",
  productCode: 1,
  year: 2026,
  timing: dtd(3840, 2160, "50"),
  link: "hdmi2.0",
  formats: ["rgb"],
  depths: [10],
  include640x480: true,
});

describe("setIdentity", () => {
  it("sets manufacturer, product, serial, name, serial text, week and year", () => {
    const e = setIdentity(built, { manufacturerId: "ABC", productCode: 0x1234, serialNumber: 42, name: "Wall B", serialText: "SN-0042", week: 12, year: 2025 });
    expect(manufacturerId(e.base.manufacturerCode)).toBe("ABC");
    expect([e.base.productCode, e.base.serialNumber, e.base.week, e.base.yearOffset]).toEqual([0x1234, 42, 12, 35]);
    expect(e.base.descriptors.filter((d) => d.kind === "text").map((d) => d.kind === "text" && [d.tag, d.text])).toEqual([
      [0xfc, "Wall B"],
      [0xff, "SN-0042"],
    ]);
    roundTrips(e);
  });

  it("refuses values the fields cannot hold, by name", () => {
    expect(() => setIdentity(built, { productCode: 0x10000 })).toThrow(/product code/);
    expect(() => setIdentity(built, { week: 55 })).toThrow(/week/);
    expect(() => setIdentity(built, { year: 1989 })).toThrow(/year/);
    expect(() => setIdentity(built, { serialText: "fourteen chars" })).toThrow(/13/);
  });
});

describe("setSerial", () => {
  it("sets the numeric serial and keeps a serial text descriptor in step", () => {
    const withText = setIdentity(built, { serialText: "1" });
    const e = setSerial(withText, 7);
    expect(e.base.serialNumber).toBe(7);
    expect(e.base.descriptors.find((d) => d.kind === "text" && d.tag === 0xff)).toEqual({ kind: "text", tag: 0xff, text: "7" });
    expect(setSerial(built, 7).base.descriptors).toEqual(built.base.descriptors);
  });
});

describe("setHdmiCaps", () => {
  it("states up to 340 MHz in the HDMI VSDB and above it in the HDMI Forum VSDB", () => {
    const low = setHdmiCaps(built, { maxTmdsMHz: 300 });
    expect(cta(low).dataBlocks.find((b) => b.kind === "hdmiVsdb")).toMatchObject({ maxTmdsClock5MHz: 60 });
    expect(cta(low).dataBlocks.find((b) => b.kind === "hdmiForumVsdb")).toMatchObject({ maxTmdsCharRate5MHz: 0 });
    const high = setHdmiCaps(built, { maxTmdsMHz: 600 });
    expect(cta(high).dataBlocks.find((b) => b.kind === "hdmiVsdb")).toMatchObject({ maxTmdsClock5MHz: 68 });
    expect(cta(high).dataBlocks.find((b) => b.kind === "hdmiForumVsdb")).toMatchObject({ maxTmdsCharRate5MHz: 120 });
    roundTrips(high);
  });

  it("adds an HDMI Forum VSDB after the HDMI VSDB when SCDC or a rate above 340 MHz needs one", () => {
    const plain = buildEdid({ ...{ name: "x", manufacturerId: "VYV", productCode: 1, year: 2026 }, timing: dtd(1920, 1080, "60"), link: "hdmi2.0", formats: ["rgb"], depths: [8] });
    expect(cta(plain).dataBlocks.some((b) => b.kind === "hdmiForumVsdb")).toBe(false);
    const e = setHdmiCaps(plain, { scdc: true });
    const kinds = cta(e).dataBlocks.map((b) => b.kind);
    expect(kinds.indexOf("hdmiForumVsdb")).toBe(kinds.indexOf("hdmiVsdb") + 1);
    expect(cta(e).dataBlocks.find((b) => b.kind === "hdmiForumVsdb")).toMatchObject({ scdcPresent: true, maxTmdsCharRate5MHz: 0 });
    roundTrips(e);
  });

  it("sets the max FRL rate, adding an HDMI Forum VSDB if needed, and refuses unknown codes", () => {
    const e = setHdmiCaps(built, { maxFrlRate: 3, maxTmdsMHz: 600 });
    expect(cta(e).dataBlocks.find((b) => b.kind === "hdmiForumVsdb")).toMatchObject({ maxFrlRate: 3, maxTmdsCharRate5MHz: 120 });
    expect(validateEdid(e).filter((i) => i.severity === "error")).toEqual([]);
    expect(() => setHdmiCaps(built, { maxFrlRate: 7 })).toThrow(/FRL/);
  });

  it("sets the physical address", () => {
    expect(cta(setHdmiCaps(built, { physicalAddress: "2.1.0.0" })).dataBlocks.find((b) => b.kind === "hdmiVsdb")).toMatchObject({ physicalAddress: 0x2100 });
    expect(() => setHdmiCaps(built, { physicalAddress: "16.0.0.0" })).toThrow(/physical address/);
    expect(() => setHdmiCaps(built, { maxTmdsMHz: 700 })).toThrow(/600/);
  });

  it("needs an HDMI VSDB", () => {
    const dvi = buildEdid({ name: "x", manufacturerId: "VYV", productCode: 1, year: 2026, timing: dtd(1920, 1080, "60"), link: "dvi", formats: ["rgb"], depths: [8] });
    expect(() => setHdmiCaps(dvi, { maxTmdsMHz: 300 })).toThrow(EdidEncodeError);
  });
});

describe("setAudio and stripAudio", () => {
  it("writes an LPCM audio block and a speaker allocation block, and sets basic audio", () => {
    const e = setAudio(built, { channels: 6, ratesKHz: [32, 44.1, 48, 96], depths: [16, 24] });
    const c = cta(e);
    expect(c.basicAudio).toBe(true);
    // CTA-861 SAD: format 1 (LPCM) and channels - 1; rate bits 32=0, 44.1=1, 48=2, 96=4; size bits 16=0, 24=2 (edid-decode cta_audio_block()).
    expect(c.dataBlocks.find((b) => b.kind === "audio")).toEqual({ kind: "audio", sads: [[0x0d, 0x17, 0x05]] });
    // 5.1: FL/FR, LFE1, FC, LS/RS (edid-decode cta_speaker_map).
    expect(c.dataBlocks.find((b) => b.kind === "speakerAllocation")).toEqual({ kind: "speakerAllocation", speakers: 0x0f });
    roundTrips(e);
    expect(validateEdid(e).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("strips audio and speaker blocks and clears basic audio (dell-p2415q-hdmi2.0)", () => {
    const orig = load("dell-p2415q-hdmi2.0");
    expect(cta(orig).basicAudio).toBe(true);
    const e = stripAudio(orig);
    expect(cta(e).basicAudio).toBe(false);
    expect(cta(e).dataBlocks.some((b) => b.kind === "audio" || b.kind === "speakerAllocation" || (b.kind === "raw" && [1, 4].includes((b.bytes[0] ?? 0) >> 5)))).toBe(false);
    roundTrips(e);
  });

  it("refuses rates and depths LPCM does not have", () => {
    expect(() => setAudio(built, { channels: 2, ratesKHz: [50], depths: [16] })).toThrow(/50 kHz/);
    expect(() => setAudio(built, { channels: 3, ratesKHz: [48], depths: [16] })).toThrow(/channels/);
  });

  it("types the audio blocks of real EDIDs and round-trips them", () => {
    for (const f of ["dell-p2415q-hdmi2.0", "samsung-q800t-hdmi2.1", "lg-oled-c9-hdmi"]) {
      const bytes = new Uint8Array(readFileSync(join(CORPUS_DIR, "edid-decode", f)));
      const e = parseEdid(bytes);
      expect(cta(e).dataBlocks.some((b) => b.kind === "audio"), f).toBe(true);
      expect(serializeEdid(e)).toEqual(bytes);
    }
  });
});

describe("addMode", () => {
  it("stores a standard timing as a VIC when a CTA block is there", () => {
    const e = addMode(built, { width: 1920, height: 1080, refresh: "60", formula: "vic" });
    expect(cta(e).dataBlocks.find((b) => b.kind === "video")).toEqual({ kind: "video", svds: [{ vic: 16, native: false }] });
    roundTrips(e);
  });

  it("stores anything else as a DTD, and a raster too large for one in DisplayID, not preferred", () => {
    const d = addMode(built, { width: 2560, height: 1440, refresh: "50", formula: "exact" });
    expect(d.base.descriptors.filter((x) => x.kind === "dtd").map((x) => x.kind === "dtd" && x.hActive)).toEqual([3840, 2560]);
    const w = addMode(built, { width: 5760, height: 1080, refresh: "50", formula: "exact" });
    expect(displayIdTimings(w).map((t) => [t.hActive, t.flags & 0x80])).toEqual([[5760, 0]]);
    roundTrips(w);
  });

  it("can be told which encoding to use", () => {
    const e = addMode(built, { width: 1920, height: 1080, refresh: "60", formula: "vic", encoding: "dtd" });
    expect(cta(e).dataBlocks.some((b) => b.kind === "video")).toBe(false);
    expect(() => addMode(built, { width: 2560, height: 1440, refresh: "50", formula: "exact", encoding: "vic" })).toThrow(/no VIC/);
  });
});

describe("removeMode", () => {
  it("removes every encoding of a mode: DTD, SVD, standard and established timings", () => {
    const orig = tessera();
    const e = removeMode(orig, { width: 3840, height: 2160, refreshHz: 60 });
    // The 4K60 DTD and VIC 97 are gone; 4K50 (VIC 96) stays.
    expect(e.base.descriptors.some((d) => d.kind === "dtd" && d.hActive === 3840)).toBe(false);
    const vics = cta(e).dataBlocks.flatMap((b) => (b.kind === "video" ? b.svds.map((s) => s.vic) : []));
    expect(vics).not.toContain(97);
    expect(vics).toContain(96);
    roundTrips(e);
  });

  it("removes a DisplayID timing, and the section when it empties", () => {
    const w = addMode(built, { width: 5760, height: 1080, refresh: "50", formula: "exact" });
    const e = removeMode(w, { width: 5760, height: 1080, refreshHz: 50 });
    expect(e.extensions.map((x) => x.kind)).toEqual(["cta"]);
    expect(cta(e).dataBlocks.some((b) => b.kind === "raw" && b.bytes[1] === 0x78)).toBe(false);
    roundTrips(e);
  });

  it("says when there is nothing to remove", () => {
    expect(() => removeMode(built, { width: 1234, height: 567, refreshHz: 60 })).toThrow("no 1234x567 @ 60 Hz mode to remove");
  });
});

describe("the corpus survives the audio typing", () => {
  it("every corpus EDID still round-trips byte for byte", () => {
    for (const f of ["dell-p2415q-hdmi2.0", "samsung-q800t-hdmi2.1", "lg-oled-c9-hdmi", "apple-xdr-6k"]) {
      const bytes = new Uint8Array(readFileSync(join(CORPUS_DIR, "edid-decode", f)));
      expect(serializeEdid(load(f))).toEqual(bytes);
    }
  });
});
