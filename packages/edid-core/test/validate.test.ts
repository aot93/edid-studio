// One case per rule: break a clean EDID so the rule fires, then check that
// its fix (when it has one) clears it. SPEC.md section 8: "A rule without a
// test is not merged" — the coverage test below enforces that.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  blockChecksum,
  buildEdid,
  buildTiming,
  importEdid,
  RULES,
  serializeEdid,
  validateBytes,
  validateEdid,
} from "../src/index.ts";
import type { CtaExtension, DataBlock, Descriptor, Edid, HdmiVsdb, RuleId } from "../src/index.ts";
import { FIXTURES_DIR } from "./corpus.ts";

const dtd = (w: number, h: number, hz: string) => {
  const r = buildTiming({ hActive: w, vActive: h, refresh: hz, formula: "exact" });
  if (!r.dtd) throw new Error(r.dtdProblems.join());
  return r.dtd;
};

/** A clean HDMI 2.0 EDID: 4K50 at 444 MHz, 10-bit RGB, with 640x480. */
const clean = buildEdid({
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
const cleanBytes = serializeEdid(clean);
const tessera = (f: string) => importEdid(readFileSync(join(FIXTURES_DIR, f), "utf8"));

const cta = (e: Edid): CtaExtension => {
  const x = e.extensions[0];
  if (x?.kind !== "cta") throw new Error("no CTA");
  return x;
};
const withCta = (e: Edid, f: (c: CtaExtension) => CtaExtension): Edid => ({ ...e, extensions: e.extensions.map((x, i) => (i === 0 && x.kind === "cta" ? f(x) : x)) });
const withBlocks = (e: Edid, f: (b: readonly DataBlock[]) => DataBlock[]): Edid => withCta(e, (c) => ({ ...c, dataBlocks: f(c.dataBlocks) }));
const withVsdb = (e: Edid, f: (b: HdmiVsdb) => HdmiVsdb): Edid => withBlocks(e, (bs) => bs.map((b) => (b.kind === "hdmiVsdb" ? f(b) : b)));
const withBase = (e: Edid, f: (b: Edid["base"]) => Partial<Edid["base"]>): Edid => ({ ...e, base: { ...e.base, ...f(e.base) } });
const withDescriptor = (e: Edid, index: number, d: Descriptor): Edid => withBase(e, (b) => ({ descriptors: b.descriptors.map((x, i) => (i === index ? d : x)) }));
const raw = (bytes: number[]): Descriptor => ({ kind: "raw", bytes: [...bytes, ...new Array<number>(18 - bytes.length).fill(0)] });
const nameSlot = clean.base.descriptors.findIndex((d) => d.kind === "text");
const rangeSlot = clean.base.descriptors.findIndex((d) => d.kind === "rangeLimits");
const range = clean.base.descriptors[rangeSlot];
if (range?.kind !== "rangeLimits") throw new Error("no range limits");

/** Recomputes every checksum after a raw byte edit. */
function resum(bytes: Uint8Array): Uint8Array {
  const out = Uint8Array.from(bytes);
  for (let b = 0; b < out.length / 128; b++) out[b * 128 + 127] = blockChecksum(out.subarray(b * 128, b * 128 + 128));
  return out;
}
function patch(bytes: Uint8Array, at: number, value: number): Uint8Array {
  const out = Uint8Array.from(bytes);
  out[at] = value;
  return out;
}

type Case = { readonly input: Edid | Uint8Array; readonly fixable: boolean; readonly severity?: string };

const CASES: Record<RuleId, Case> = {
  "structure.length": { input: cleanBytes.subarray(0, 255), fixable: false },
  "structure.header": { input: patch(cleanBytes, 0, 1), fixable: false },
  "structure.checksum": { input: patch(cleanBytes, 127, (cleanBytes[127] ?? 0) ^ 1), fixable: false },
  "cta.revision": { input: resum(patch(cleanBytes, 129, 1)), fixable: false },
  // One byte short: the offset lands inside the last data block.
  "cta.offset": { input: resum(patch(cleanBytes, 130, (cleanBytes[130] ?? 0) - 1)), fixable: false },
  "cta.padding": { input: resum(patch(cleanBytes, 254, 7)), fixable: false },
  "descriptor.header": { input: withDescriptor(clean, 3, raw([0, 0, 1, 0x10])), fixable: false },
  "descriptor.tag": { input: withDescriptor(clean, 3, raw([0, 0, 0, 0x50])), fixable: false },
  "descriptor.all-zero": { input: withDescriptor(clean, 3, raw([])), fixable: true },
  "descriptor.dummy-garbage": { input: withDescriptor(clean, 3, raw([0, 0, 0, 0x10, 0, 1])), fixable: true },
  "text.printable": { input: withDescriptor(clean, nameSlot, { kind: "text", tag: 0xfc, text: "LED\u0001wall" }), fixable: false },
  "text.layout": { input: withDescriptor(clean, nameSlot, raw([0, 0, 0, 0xfc, 0, 0x41, 0x0a])), fixable: true },
  "base.preferred-timing": { input: withBase(clean, (b) => ({ features: b.features & ~0x02 })), fixable: true },
  "base.depth-on-1.3": { input: withBase(clean, (b) => ({ videoInput: b.videoInput | 0x30 })), fixable: true },
  "base.depth-reserved": { input: withBase(clean, () => ({ revision: 4, videoInput: 0xf2 })), fixable: false },
  "base.srgb": { input: withBase(clean, (b) => ({ features: b.features & ~0x04 })), fixable: true },
  "base.range-limits-missing": { input: withDescriptor(clean, rangeSlot, { kind: "dummy" }), fixable: true },
  "base.name-missing": { input: withDescriptor(clean, nameSlot, { kind: "dummy" }), fixable: false },
  "range.order": { input: withDescriptor(clean, rangeSlot, { ...range, minVerticalHz: 70, maxVerticalHz: 60 }), fixable: false },
  "range.class": { input: withDescriptor(clean, rangeSlot, { ...range, timingSupport: 0x01 }), fixable: true },
  "range.covers-timings": { input: withDescriptor(clean, rangeSlot, { ...range, maxPixelClock10MHz: 30 }), fixable: true },
  "std.unused-code": { input: withBase(clean, (b) => ({ standardTimings: b.standardTimings.map((c, i) => (i === 0 ? ([0, 0] as const) : c)) })), fixable: true },
  "svd.unknown-vic": { input: withBlocks(clean, (bs) => [{ kind: "video", svds: [{ vic: 1, native: false }, { vic: 220, native: false }] }, ...bs]), fixable: true },
  "svd.duplicate": { input: withBlocks(clean, (bs) => [{ kind: "video", svds: [{ vic: 1, native: false }, { vic: 1, native: false }] }, ...bs]), fixable: true },
  "y420.map-length": {
    input: withBlocks(clean, (bs) => [{ kind: "video", svds: [{ vic: 1, native: false }] }, { kind: "ycbcr420CapabilityMap", bitmap: [0x03] }, ...bs]),
    fixable: true,
  },
  "cta.byte3-consistent": { input: { ...clean, extensions: [cta(clean), { ...cta(clean), ycbcr444: true }] }, fixable: true },
  "cta.640x480": { input: withBase(clean, () => ({ establishedTimings: [0, 0, 0] })), fixable: true, severity: "info" },
  "hdmi.edid-version": { input: withBase(clean, () => ({ revision: 4 })), fixable: false },
  "hdmi.vsdb-structure": { input: withVsdb(clean, (b) => ({ ...b, tail: [0x80] })), fixable: false },
  "hdmi.vsdb-tmds": { input: withVsdb(clean, (b) => ({ ...b, maxTmdsClock5MHz: 100 })), fixable: true },
  "hdmi.max-tmds": { input: withBlocks(clean, (bs) => bs.map((b) => (b.kind === "hdmiForumVsdb" ? { ...b, maxTmdsCharRate5MHz: 80 } : b))), fixable: false },
  "hdmi.forum-vsdb-needed": { input: withBlocks(clean, (bs) => bs.filter((b) => b.kind !== "hdmiForumVsdb")), fixable: false },
  "hdmi.vic-equivalents": { input: withVsdb(clean, (b) => ({ ...b, tail: [0x20, 0x00, 0x20, 0x01] })), fixable: true },
  "color.y444-flag": { input: withVsdb(clean, (b) => ({ ...b, capabilities: { ...(b.capabilities ?? fail()), dcY444: true } })), fixable: true },
  "color.y444-depth": {
    input: withCta(withVsdb(clean, (b) => ({ ...b, capabilities: { ...(b.capabilities ?? fail()), dcY444: true, dc30bit: false } })), (c) => ({ ...c, ycbcr444: true })),
    fixable: true,
  },
  "color.420-depth": { input: withBlocks(clean, (bs) => bs.map((b) => (b.kind === "hdmiForumVsdb" ? { ...b, dc30bit420: true } : b))), fixable: true },
  "link.too-fast": { input: tessera("Tessera-EJE-test.txt").edid, fixable: false },
  "link.depth-unusable": { input: tessera("Tessera-SX40.txt").edid, fixable: true },
};

function fail(): never {
  throw new Error("fixture is missing a capability byte");
}

function issuesOf(input: Edid | Uint8Array) {
  return input instanceof Uint8Array ? validateBytes(input).issues : validateBytes(serializeEdid(input)).issues;
}

describe("the clean baseline", () => {
  it("has no issues at all", () => {
    expect(validateBytes(cleanBytes).issues).toEqual([]);
  });
});

describe("every rule has a test", () => {
  it("covers each rule ID", () => {
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(RULES).sort());
  });
});

describe("rules", () => {
  for (const [rule, c] of Object.entries(CASES) as [RuleId, Case][]) {
    it(`${rule} fires${c.fixable ? " and its fix clears it" : ""}`, () => {
      const found = issuesOf(c.input).filter((i) => i.rule === rule);
      expect(found.length, `expected ${rule}`).toBeGreaterThan(0);
      const first = found[0];
      if (!first) return;
      expect(first.severity).toBe(c.severity ?? RULES[rule].severity);
      expect(first.message.length).toBeGreaterThan(10);
      if (!c.fixable) {
        expect(first.fix).toBeUndefined();
        return;
      }
      const fix = first.fix;
      expect(fix, `${rule} should offer a fix`).toBeDefined();
      if (!fix || c.input instanceof Uint8Array) return;
      const fixed = fix.apply(c.input);
      expect(validateEdid(fixed).filter((i) => i.rule === rule).length).toBeLessThan(found.length);
      // A fix must still produce an exportable EDID.
      expect(() => serializeEdid(fixed)).not.toThrow();
    });
  }
});

describe("the Tessera files", () => {
  it("the original has no errors; its warnings explain the 10-bit fallback", () => {
    const r = validateBytes(tessera("Tessera-EJE-test.txt").bytes);
    expect(r.errors).toBe(0);
    expect(r.issues.filter((i) => i.rule === "link.too-fast")).toHaveLength(3);
  });

  it("the working file has no errors, only the two rules NVIDIA accepted", () => {
    const r = validateBytes(tessera("Tessera-EJE-4K50-10bit-RGB.txt").bytes);
    expect(r.errors).toBe(0);
    expect(r.issues.filter((i) => i.severity === "warning").map((i) => i.rule).sort()).toEqual(["base.srgb", "range.class"]);
  });
});

describe("docs/rules.md", () => {
  it("matches the rule table (run pnpm rules-doc after changing rules)", async () => {
    const { rulesMarkdown } = await import("../src/index.ts");
    expect(readFileSync(join(FIXTURES_DIR, "../../docs/rules.md"), "utf8")).toBe(rulesMarkdown());
  });
});
