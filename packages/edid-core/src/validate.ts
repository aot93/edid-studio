// Validation rules (SPEC.md section 8). Every rule has a stable ID, a tier,
// a severity, a plain-language message and, where safe, an automatic fix.
// Tier 1 is structural, tier 2 semantic, tier 3 link feasibility.
//
// Severities follow edid-decode (fail = error, warn = warning) except where
// a hardware-verified case shows a source accepts the EDID anyway; those
// rules are warnings and say so (see the Tessera notes in SPEC.md section 14).

import { analyzeLink, advertisedColour } from "./analyze.ts";
import { EDID_HEADER } from "./base-block.ts";
import { decodeStandardTiming, ESTABLISHED_TIMINGS, isEstablishedSet, UNUSED_STANDARD_TIMING } from "./base-timings.ts";
import { encodeChromaticity, SRGB } from "./build.ts";
import { BLOCK_SIZE, blockChecksum, blockSum, byteAt, bytesEqual, isAllZero, slice } from "./bytes.ts";
import { describeDtd, lookupVic } from "./describe.ts";
import { describeDisplayIdTiming, displayIdTimings } from "./displayid.ts";
import { EXT_HF_EEODB } from "./cta.ts";
import { DISPLAYID_EXTENSION_TAG, MAX_SECTION_LENGTH } from "./displayid.ts";
import { declaredExtensionCount, expectedEdidLength, parseEdid } from "./edid.ts";
import { feasibility, LINKS, tmdsRateKHz } from "./link.ts";
import type { Link } from "./link.ts";
import type { NodeRef } from "./layout.ts";
import type { CtaExtension, DataBlock, Descriptor, Edid, HdmiVsdb } from "./model.ts";
import { autoRangeLimits, makePreferred, removeHdmiVideo, removeSvd, setHdmiDeepColour, setHf420DeepColour, setRangeLimits, setStandardTimings } from "./ops.ts";

export type Severity = "error" | "warning" | "info";

export interface Fix {
  readonly label: string;
  readonly apply: (edid: Edid) => Edid;
}

export interface Issue {
  readonly rule: RuleId;
  readonly tier: 1 | 2 | 3;
  readonly severity: Severity;
  readonly message: string;
  /** The model node the issue is about, for jumping to it in the UI. */
  readonly where?: NodeRef;
  readonly fix?: Fix;
}

export interface RuleInfo {
  readonly tier: 1 | 2 | 3;
  readonly severity: Severity;
  readonly title: string;
}

/** Every rule, by stable ID. IDs never change meaning; retired IDs are not reused. */
export const RULES = {
  "structure.length": { tier: 1, severity: "error", title: "Length is 128 x (1 + extension count)" },
  "structure.header": { tier: 1, severity: "error", title: "Block 0 starts with the EDID header" },
  "structure.checksum": { tier: 1, severity: "error", title: "Every block sums to zero" },
  "cta.revision": { tier: 1, severity: "warning", title: "CTA-861 extension is revision 3" },
  "cta.offset": { tier: 1, severity: "error", title: "CTA DTD offset matches the data block collection" },
  "cta.padding": { tier: 1, severity: "error", title: "CTA padding after the DTDs is zero" },
  "structure.block-map": { tier: 1, severity: "error", title: "EDID 1.3 with more than two blocks has a block map or an HDMI Forum EEODB" },
  "displayid.section": { tier: 1, severity: "error", title: "DisplayID sections are well formed" },
  "descriptor.header": { tier: 1, severity: "error", title: "Display descriptor bytes 2 and 4 are zero" },
  "descriptor.tag": { tier: 1, severity: "error", title: "Display descriptor tag is defined" },
  "descriptor.all-zero": { tier: 1, severity: "warning", title: "Unused descriptors are dummy descriptors" },
  "descriptor.dummy-garbage": { tier: 1, severity: "error", title: "Dummy descriptors are all zero after the tag" },
  "text.printable": { tier: 1, severity: "error", title: "Text descriptors hold printable ASCII" },
  "text.layout": { tier: 1, severity: "warning", title: "Text ends with 0x0a and is padded with spaces" },
  "base.preferred-timing": { tier: 2, severity: "error", title: "The first descriptor is the preferred detailed timing" },
  "base.depth-on-1.3": { tier: 2, severity: "error", title: "Bit depth is only set on EDID 1.4" },
  "base.depth-reserved": { tier: 2, severity: "error", title: "EDID 1.4 bit depth is not the reserved value" },
  "base.srgb": { tier: 2, severity: "warning", title: "sRGB chromaticity and the sRGB flag agree" },
  "base.range-limits-missing": { tier: 2, severity: "error", title: "EDID 1.3 has a range limits descriptor" },
  "base.name-missing": { tier: 2, severity: "warning", title: "A monitor name is present" },
  "range.order": { tier: 2, severity: "error", title: "Range minimums do not exceed maximums" },
  "range.class": { tier: 2, severity: "warning", title: "Range limit class is allowed for the EDID version" },
  "range.covers-timings": { tier: 2, severity: "warning", title: "Range limits cover every timing" },
  "std.unused-code": { tier: 2, severity: "error", title: "Unused standard timings are 01 01" },
  "svd.unknown-vic": { tier: 2, severity: "error", title: "Every SVD is a known VIC" },
  "svd.duplicate": { tier: 2, severity: "error", title: "No VIC is listed twice" },
  "y420.map-length": { tier: 2, severity: "error", title: "4:2:0 capability map has no more bits than SVDs" },
  "cta.byte3-consistent": { tier: 2, severity: "error", title: "Byte 3 is the same in every CTA extension" },
  "cta.640x480": { tier: 2, severity: "info", title: "640x480 @ 60 Hz is listed (CTA-861)" },
  "hdmi.edid-version": { tier: 2, severity: "warning", title: "HDMI sinks use EDID 1.3" },
  "hdmi.vsdb-structure": { tier: 2, severity: "error", title: "HDMI VSDB length covers every field it sets" },
  "hdmi.vsdb-tmds": { tier: 2, severity: "error", title: "HDMI VSDB max TMDS clock is at most 340 MHz" },
  "hdmi.max-tmds": { tier: 2, severity: "error", title: "Max TMDS covers the fastest mode" },
  "hdmi.vic-equivalents": { tier: 2, severity: "error", title: "HDMI VICs have their CTA-861 VICs in the video data block" },
  "hdmi.forum-vsdb-needed": { tier: 2, severity: "error", title: "Modes above 340 MHz have an HDMI Forum VSDB with SCDC" },
  "color.y444-flag": { tier: 2, severity: "error", title: "DC_Y444 needs YCbCr 4:4:4 support" },
  "color.y444-depth": { tier: 2, severity: "warning", title: "DC_Y444 needs a deep colour depth" },
  "color.420-depth": { tier: 2, severity: "warning", title: "4:2:0 deep colour needs 4:2:0 modes" },
  "link.too-fast": { tier: 3, severity: "warning", title: "Advertised depths fit the link at every mode" },
  "link.depth-unusable": { tier: 3, severity: "warning", title: "Every advertised depth is usable at some mode" },
} as const satisfies Record<string, RuleInfo>;

export type RuleId = keyof typeof RULES;

function issue(rule: RuleId, message: string, extra: { where?: NodeRef; fix?: Fix; severity?: Severity } = {}): Issue {
  const info = RULES[rule];
  return {
    rule,
    tier: info.tier,
    severity: extra.severity ?? info.severity,
    message,
    ...(extra.where ? { where: extra.where } : {}),
    ...(extra.fix ? { fix: extra.fix } : {}),
  };
}

export interface ValidationOptions {
  /** Link for tier 3. Default HDMI 2.0. */
  readonly link?: Link;
}

export interface ValidationReport {
  readonly issues: readonly Issue[];
  readonly errors: number;
  readonly warnings: number;
  /** The parsed model, when the bytes could be parsed. */
  readonly edid?: Edid;
}

function report(issues: Issue[], edid?: Edid): ValidationReport {
  return {
    issues,
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warning").length,
    ...(edid ? { edid } : {}),
  };
}

/** Tier 1 on the raw bytes, then tiers 1 to 3 on the parsed model. */
export function validateBytes(bytes: ArrayLike<number>, options: ValidationOptions = {}): ValidationReport {
  const issues: Issue[] = [];
  if (bytes.length < BLOCK_SIZE || bytes.length % BLOCK_SIZE !== 0) {
    return report([issue("structure.length", `The EDID is ${bytes.length} bytes; it must be a whole number of 128-byte blocks.`)]);
  }
  if (!bytesEqual(slice(bytes, 0, 8), EDID_HEADER)) {
    return report([issue("structure.header", "Block 0 does not start with 00 ff ff ff ff ff ff 00.")]);
  }
  const count = declaredExtensionCount(bytes);
  if (bytes.length !== expectedEdidLength(count)) {
    return report([
      issue(
        "structure.length",
        `The EDID is ${bytes.length} bytes but declares ${count} extension block(s), so it must be ${expectedEdidLength(count)} bytes.`,
      ),
    ]);
  }
  for (let b = 0; b < bytes.length / BLOCK_SIZE; b++) {
    if (blockSum(bytes, b) !== 0) {
      const want = blockChecksum(slice(bytes, b * BLOCK_SIZE, (b + 1) * BLOCK_SIZE));
      issues.push(
        issue("structure.checksum", `Block ${b} checksum is ${hex(byteAt(bytes, b * BLOCK_SIZE + 127))}; it should be ${hex(want)}. Every export writes the correct value.`, {
          where: { type: "checksum", block: b },
        }),
      );
    }
    if (b > 0) issues.push(...ctaBlockStructure(slice(bytes, b * BLOCK_SIZE, (b + 1) * BLOCK_SIZE), b));
    if (b > 0) issues.push(...displayIdBlockStructure(slice(bytes, b * BLOCK_SIZE, (b + 1) * BLOCK_SIZE), b));
  }
  const edid = parseEdid(bytes);
  issues.push(...validateEdid(edid, options));
  return report(issues, edid);
}

/** Byte-level checks of a CTA-861 block (edid-decode parse_cta_block()). */
function ctaBlockStructure(block: readonly number[], blockNumber: number): Issue[] {
  const b = (i: number) => byteAt(block, i);
  if (b(0) !== 0x02) return [];
  const where: NodeRef = { type: "block", block: blockNumber };
  if (b(1) !== 3) return [issue("cta.revision", `Block ${blockNumber} is a CTA-861 extension of revision ${b(1)}; only revision 3 is decoded and edited.`, { where })];
  const offset = b(2);
  if (offset === 0) return [];
  if (offset < 4 || offset > 127) return [issue("cta.offset", `Block ${blockNumber} has DTD offset ${offset}; it must be 0 or 4 to 127.`, { where })];
  let i = 4;
  while (i < offset) i += (b(i) & 0x1f) + 1;
  if (i !== offset) {
    return [issue("cta.offset", `Block ${blockNumber} says its DTDs start at byte ${offset}, but its data blocks end at byte ${i}.`, { where })];
  }
  let d = offset;
  while (d + 18 <= 127 && !isAllZero(slice(block, d, d + 18))) d += 18;
  if (!isAllZero(slice(block, d, 127))) {
    return [issue("cta.padding", `Block ${blockNumber} has non-zero bytes in its padding after the DTDs.`, { where })];
  }
  return [];
}

/**
 * Byte-level checks of a DisplayID section in an extension block (edid-decode
 * parse_displayid_block(), displayid_block(); drm validate_displayid()).
 */
function displayIdBlockStructure(block: readonly number[], blockNumber: number): Issue[] {
  const b = (i: number) => byteAt(block, i);
  if (b(0) !== DISPLAYID_EXTENSION_TAG) return [];
  const where: NodeRef = { type: "block", block: blockNumber };
  const bad = (why: string) => [issue("displayid.section", `Block ${blockNumber} is a DisplayID section, but ${why}. Sources may ignore its timings.`, { where })];
  const length = b(2);
  if (length > MAX_SECTION_LENGTH) return bad(`its length ${length} exceeds ${MAX_SECTION_LENGTH}`);
  const end = 5 + length;
  let i = 5;
  while (end - i >= 3 && !(b(i) === 0 && b(i + 2) === 0)) {
    const next = i + 3 + b(i + 2);
    if (next > end) return bad(`data block 0x${hex(b(i))} at byte ${i} runs past the end of the section`);
    i = next;
  }
  if (!isAllZero(slice(block, i, end))) return bad("the filler after its data blocks is not zero");
  const sum = slice(block, 1, end + 1).reduce((a, v) => a + v, 0) & 0xff;
  if (sum !== 0) return bad(`its section checksum (byte ${end}) is 0x${hex(b(end))}; it should be 0x${hex((b(end) - sum) & 0xff)}`);
  if (!isAllZero(slice(block, end + 1, 127))) return bad("the padding after the section is not zero");
  return [];
}

interface Mode {
  readonly label: string;
  readonly refreshHz: number;
  readonly hKHz: number;
  readonly clockKHz: number;
  /** Only carried as YCbCr 4:2:0 (listed in a 4:2:0 video data block). */
  readonly only420: boolean;
}

function ctaBlocks(edid: Edid): { cta: CtaExtension; extension: number }[] {
  return edid.extensions.flatMap((e, extension) => (e.kind === "cta" ? [{ cta: e, extension }] : []));
}

/**
 * Established timings, standard timings, detailed timings and VICs with their
 * rates. A standard timing states only its refresh; its line rate and clock
 * depend on GTF or CVT, so they are NaN here and only the vertical check uses it.
 */
function listModes(edid: Edid): Mode[] {
  const modes: Mode[] = [];
  for (const code of edid.base.standardTimings) {
    const t = decodeStandardTiming(code);
    if (t) modes.push({ label: `${t.hActive}x${t.vActive} @ ${t.refreshHz} Hz`, refreshHz: t.refreshHz, hKHz: Number.NaN, clockKHz: Number.NaN, only420: false });
  }
  for (const t of ESTABLISHED_TIMINGS) {
    if (isEstablishedSet(edid.base.establishedTimings, t)) modes.push({ label: t.label, refreshHz: t.refreshHz, hKHz: t.hKHz, clockKHz: t.clockKHz, only420: false });
  }
  const dtds = [...edid.base.descriptors, ...ctaBlocks(edid).flatMap(({ cta }) => cta.descriptors)];
  for (const d of dtds) {
    if (d.kind !== "dtd") continue;
    const i = describeDtd(d);
    modes.push({ label: `${i.hActive}x${i.vActive}`, refreshHz: i.refreshHz, hKHz: i.pixelClockKHz / i.hTotal, clockKHz: i.pixelClockKHz, only420: false });
  }
  for (const t of displayIdTimings(edid)) {
    const i = describeDisplayIdTiming(t);
    modes.push({ label: `${i.hActive}x${i.vActive}`, refreshHz: i.refreshHz, hKHz: i.pixelClockKHz / i.hTotal, clockKHz: i.pixelClockKHz, only420: false });
  }
  for (const { cta } of ctaBlocks(edid)) {
    for (const b of cta.dataBlocks) {
      if (b.kind !== "video" && b.kind !== "ycbcr420Video") continue;
      for (const s of b.svds) {
        const v = lookupVic(s.vic);
        if (v) modes.push({ label: `VIC ${s.vic}`, refreshHz: v.refreshHz, hKHz: v.pixelClockKHz / v.hTotal, clockKHz: v.pixelClockKHz, only420: b.kind === "ycbcr420Video" });
      }
    }
  }
  return modes;
}

/** Tiers 1 (model level), 2 and 3 on a model. */
export function validateEdid(edid: Edid, options: ValidationOptions = {}): Issue[] {
  const link = options.link ?? "hdmi2.0";
  return [...blockMapRules(edid), ...descriptorRules(edid), ...baseRules(edid), ...rangeRules(edid), ...ctaRules(edid), ...hdmiRules(edid), ...linkRules(edid, link)];
}

/**
 * EDID 1.3 reaches past block 1 only through a block map in block 1 or an
 * HDMI Forum EEODB (edid-decode check_base_block()); sources without either
 * may read two blocks only.
 */
function blockMapRules(edid: Edid): Issue[] {
  if (edid.base.version !== 1 || edid.base.revision !== 3 || edid.extensions.length < 2) return [];
  const first = edid.extensions[0];
  if (first?.kind === "raw" && first.bytes[0] === 0xf0) return [];
  if (first?.kind === "cta" && first.dataBlocks.some(isEeodb)) return [];
  const count = edid.extensions.length;
  return [
    issue("structure.block-map", `This EDID 1.3 has ${count + 1} blocks, but block 1 has no block map or HDMI Forum EEODB to say so; sources may read only the first two.`, {
      where: { type: "extensionCount" },
      ...(first?.kind === "cta" && count <= 255
        ? {
            fix: {
              label: "Add an HDMI Forum EEODB to block 1",
              apply: (e: Edid) => ({
                ...e,
                extensions: e.extensions.map((x, i) => (i === 0 && x.kind === "cta" ? { ...x, dataBlocks: [{ kind: "raw", bytes: [(7 << 5) | 2, EXT_HF_EEODB, count] } as const, ...x.dataBlocks] } : x)),
              }),
            },
          }
        : {}),
    }),
  ];
}

function isEeodb(b: DataBlock): boolean {
  return b.kind === "raw" && b.bytes[0] !== undefined && b.bytes[0] >> 5 === 7 && b.bytes[1] === EXT_HF_EEODB;
}

function descriptorRules(edid: Edid): Issue[] {
  const out: Issue[] = [];
  const all: { d: Descriptor; where: NodeRef; at: { extension?: number; index: number } }[] = [
    ...edid.base.descriptors.map((d, index) => ({ d, where: { type: "baseDescriptor", index } as NodeRef, at: { index } })),
    ...ctaBlocks(edid).flatMap(({ cta, extension }) =>
      cta.descriptors.map((d, index) => ({ d, where: { type: "ctaDescriptor", extension, index } as NodeRef, at: { extension, index } })),
    ),
  ];
  const toDummy = (at: { extension?: number; index: number }): Fix => ({
    label: "Replace with a dummy descriptor",
    apply: (e) => replaceAt(e, at, { kind: "dummy" }),
  });
  for (const { d, where, at } of all) {
    if (d.kind === "text") {
      const bad = [...d.text].find((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) > 0x7e);
      if (bad !== undefined) out.push(issue("text.printable", `Text "${printableText(d.text)}" contains byte ${hex(bad.charCodeAt(0))}, which is not printable ASCII.`, { where }));
      continue;
    }
    if (d.kind !== "raw") continue;
    const x = d.bytes;
    if (x[0] !== 0 || x[1] !== 0) continue; // A DTD the model could not type; tier 2 covers timings.
    if (isAllZero(x)) {
      out.push(issue("descriptor.all-zero", "This descriptor is all zeros; an unused slot should be a dummy descriptor (tag 0x10).", { where, fix: toDummy(at) }));
      continue;
    }
    const tag = x[3] ?? 0;
    if (x[2] !== 0 || (x[4] !== 0 && !(tag === 0xfd && edid.base.revision >= 4))) {
      out.push(issue("descriptor.header", `Display descriptor 0x${hex(tag)} has a non-zero byte 2 or byte 4.`, { where }));
    }
    if (tag === 0x10 && !isAllZero(x.slice(5))) {
      out.push(issue("descriptor.dummy-garbage", "A dummy descriptor holds non-zero data.", { where, fix: toDummy(at) }));
    } else if (tag > 0x10 && tag < 0xf7) {
      out.push(issue("descriptor.tag", `Display descriptor tag 0x${hex(tag)} is reserved.`, { where }));
    } else if (tag === 0xfc || tag === 0xfe || tag === 0xff) {
      const payload = x.slice(5);
      const end = payload.findIndex((v) => v === 0x0a || v === 0x00);
      const text = String.fromCharCode(...(end === -1 ? payload : payload.slice(0, end))).trimEnd();
      const printable = /^[\x20-\x7e]*$/.test(text);
      out.push(
        issue("text.layout", `Text "${printableText(text)}" is not ended by 0x0a and padded with spaces.`, {
          where,
          ...(printable && text.length > 0 ? { fix: { label: "Rewrite with standard padding", apply: (e: Edid) => replaceAt(e, at, { kind: "text", tag, text }) } } : {}),
        }),
      );
    }
  }
  return out;
}

function baseRules(edid: Edid): Issue[] {
  const out: Issue[] = [];
  const base = edid.base;
  const v13 = base.version === 1 && base.revision === 3;
  const first = base.descriptors[0];
  const firstDtd = base.descriptors.findIndex((d) => d.kind === "dtd");

  if (v13 && !(base.features & 0x02)) {
    out.push(
      issue("base.preferred-timing", "EDID 1.3 requires the 'first detailed timing is preferred' flag (byte 24, bit 1).", {
        where: { type: "baseDisplay" },
        fix: { label: "Set the flag", apply: (e) => ({ ...e, base: { ...e.base, features: e.base.features | 0x02 } }) },
      }),
    );
  }
  if (first?.kind !== "dtd" && (base.features & 0x02 || base.revision >= 4)) {
    out.push(
      issue("base.preferred-timing", "The preferred timing must be the first descriptor, but descriptor 1 is not a detailed timing.", {
        where: { type: "baseDescriptor", index: 0 },
        ...(firstDtd > 0 ? { fix: { label: "Move the first detailed timing to slot 1", apply: (e: Edid) => makePreferred(e, { index: firstDtd }) } } : {}),
      }),
    );
  }

  const vi = base.videoInput;
  if (vi & 0x80) {
    if (base.revision < 4 && vi & 0x7e) {
      out.push(
        issue("base.depth-on-1.3", `Byte 20 is 0x${hex(vi)}: bits 6 to 1 are reserved before EDID 1.4, so bit depth cannot be set there; HDMI blocks carry it.`, {
          where: { type: "baseDisplay" },
          fix: { label: "Clear the reserved bits", apply: (e) => ({ ...e, base: { ...e.base, videoInput: e.base.videoInput & 0x81 } }) },
        }),
      );
    }
    if (base.revision >= 4 && (vi & 0x70) === 0x70) {
      out.push(issue("base.depth-reserved", "The EDID 1.4 colour bit depth is set to the reserved value 111.", { where: { type: "baseDisplay" } }));
    }
  }

  const srgbBytes = encodeChromaticity(SRGB);
  const isSrgb = bytesEqual(base.chromaticity, srgbBytes);
  const flag = (base.features & 0x04) !== 0;
  if (isSrgb && !flag) {
    out.push(
      issue("base.srgb", "The colour characteristics are sRGB, but the sRGB flag (byte 24, bit 2) is not set. edid-decode fails this; the NVIDIA driver accepted it in the Tessera case.", {
        where: { type: "baseDisplay" },
        fix: { label: "Set the sRGB flag", apply: (e) => ({ ...e, base: { ...e.base, features: e.base.features | 0x04 } }) },
      }),
    );
  } else if (!isSrgb && flag) {
    out.push(issue("base.srgb", "The sRGB flag is set, but the colour characteristics are not sRGB.", { where: { type: "chromaticity" }, severity: "error" }));
  }

  if (!base.descriptors.some((d) => d.kind === "text" && d.tag === 0xfc)) {
    out.push(issue("base.name-missing", "There is no monitor name descriptor; sources and the NVIDIA Control Panel show the display without a name."));
  }

  base.standardTimings.forEach(([a, b], i) => {
    if (a <= 0x01 && !(a === 0x01 && b === 0x01)) {
      out.push(
        issue("std.unused-code", `Standard timing ${i + 1} is ${hex(a)} ${hex(b)}; an unused slot must be 01 01.`, {
          where: { type: "standardTimings" },
          fix: { label: "Mark it unused (01 01)", apply: (e) => setStandardTimings(e, e.base.standardTimings.map((c, j) => (j === i ? UNUSED_STANDARD_TIMING : c))) },
        }),
      );
    }
  });
  return out;
}

function rangeRules(edid: Edid): Issue[] {
  const out: Issue[] = [];
  const at = edid.base.descriptors.findIndex((d) => d.kind === "rangeLimits");
  const r = edid.base.descriptors[at];
  const v13 = edid.base.revision < 4;
  if (r?.kind !== "rangeLimits") {
    // Required on EDID 1.3, and on 1.4 when continuous frequencies are declared (edid-decode parse_base_block()).
    const required = edid.base.version === 1 && (edid.base.revision === 3 || (edid.base.revision >= 4 && (edid.base.features & 0x01) !== 0));
    if (required) {
      const spec = autoRangeLimits(edid, "default");
      const free = edid.base.descriptors.some((d) => d.kind === "dummy");
      out.push(
        issue("base.range-limits-missing", `EDID ${edid.base.version}.${edid.base.revision} requires a display range limits descriptor here.`, {
          ...(spec && free ? { fix: { label: "Add range limits that cover the modes", apply: (e: Edid) => setRangeLimits(e, spec) } } : {}),
        }),
      );
    }
    return out;
  }
  const where: NodeRef = { type: "baseDescriptor", index: at };
  // EDID 1.4 rate offsets add 255 (E-EDID 1.4 table 3.26; edid-decode detailed_display_range_limits()).
  const o = v13 ? 0 : r.offsetFlags;
  const lim = {
    vMin: r.minVerticalHz + ((o & 0x03) === 0x03 ? 255 : 0),
    vMax: r.maxVerticalHz + (o & 0x02 ? 255 : 0),
    hMin: r.minHorizontalKHz + ((o & 0x0c) === 0x0c ? 255 : 0),
    hMax: r.maxHorizontalKHz + (o & 0x08 ? 255 : 0),
    clockKHz: r.maxPixelClock10MHz * 10_000,
  };
  // EDID 1.3 cannot store more than 255: a maximum of 255 means "255 or more",
  // so edid-decode doubles it before checking (detailed_display_range_limits()).
  if (v13 && r.maxHorizontalKHz === 0xff) lim.hMax *= 2;
  if (v13 && r.maxVerticalHz === 0xff) lim.vMax *= 2;
  if (lim.vMin > lim.vMax || lim.hMin > lim.hMax) out.push(issue("range.order", "A range limit minimum exceeds its maximum.", { where }));

  if (v13 && (r.timingSupport === 0x01 || r.timingSupport === 0x04)) {
    out.push(
      issue("range.class", `'${r.timingSupport === 0x01 ? "Range limits only" : "CVT"}' range limits are defined from EDID 1.4; this EDID is 1.3. edid-decode fails this; the NVIDIA driver accepted it in the Tessera case.`, {
        where,
        fix: { label: "Use default GTF (0x00)", apply: (e) => replaceAt(e, { index: at }, { ...r, timingSupport: 0x00 }) },
      }),
    );
  } else if (![0x00, 0x01, 0x02, 0x04].includes(r.timingSupport)) {
    out.push(issue("range.class", `Range limit class 0x${hex(r.timingSupport)} is undefined.`, { where, severity: "error" }));
  }

  // Thresholds follow edid-decode check_base_block(): half a hertz or kilohertz of rounding, and any clock above the limit.
  // 4:2:0-only modes count at half their line rate and clock, as edid-decode print_timings() does.
  // Not counted: anything in blocks kept raw, and DisplayID timings other than Type I.
  const outside = listModes(edid)
    .map((m) => (m.only420 ? { ...m, hKHz: m.hKHz / 2, clockKHz: m.clockKHz / 2 } : m))
    .filter(
      (m) =>
        m.refreshHz + 0.5 < lim.vMin ||
        (lim.vMax > 0 && m.refreshHz >= lim.vMax + 0.5) ||
        m.hKHz + 0.5 < lim.hMin ||
        (lim.hMax > 0 && m.hKHz >= lim.hMax + 0.5) ||
        (lim.clockKHz > 0 && m.clockKHz > lim.clockKHz),
    );
  if (outside.length > 0) {
    const spec = autoRangeLimits(edid, r.timingSupport === 0x01 ? "none" : "default");
    out.push(
      issue("range.covers-timings", `Range limits (${lim.vMin}-${lim.vMax} Hz, ${lim.hMin}-${lim.hMax} kHz, ${lim.clockKHz / 1000} MHz) do not cover ${outside.map((m) => m.label).join(", ")}.`, {
        where,
        ...(spec ? { fix: { label: "Fit the range limits to the modes", apply: (e: Edid) => setRangeLimits(e, spec) } } : {}),
      }),
    );
  }
  return out;
}

function ctaRules(edid: Edid): Issue[] {
  const out: Issue[] = [];
  const blocks = ctaBlocks(edid);
  if (blocks.length === 0) return out;

  const byte3 = (c: CtaExtension) => [c.underscan, c.basicAudio, c.ycbcr444, c.ycbcr422, c.nativeDtdCount].join();
  const firstCta = blocks[0]?.cta;
  for (const { cta, extension } of blocks.slice(1)) {
    if (firstCta && byte3(cta) !== byte3(firstCta)) {
      out.push(
        issue("cta.byte3-consistent", `CTA extension ${extension + 1} has different support flags (byte 3) from the first.`, {
          where: { type: "ctaHeader", extension },
          fix: {
            label: "Copy the first block's flags",
            apply: (e) => ({
              ...e,
              extensions: e.extensions.map((x, i) =>
                i === extension && x.kind === "cta" ? { ...x, underscan: firstCta.underscan, basicAudio: firstCta.basicAudio, ycbcr444: firstCta.ycbcr444, ycbcr422: firstCta.ycbcr422, nativeDtdCount: firstCta.nativeDtdCount } : x,
              ),
            }),
          },
        }),
      );
    }
  }

  let svdCount = 0;
  const seen = new Set<number>();
  for (const { cta, extension } of blocks) {
    cta.dataBlocks.forEach((b, index) => {
      if (b.kind !== "video") return;
      const where: NodeRef = { type: "dataBlock", extension, index };
      b.svds.forEach((s, i) => {
        if (!lookupVic(s.vic)) {
          out.push(issue("svd.unknown-vic", `VIC ${s.vic} is not a defined CTA-861 video format.`, { where, fix: { label: `Remove VIC ${s.vic}`, apply: (e) => removeSvd(e, extension, index, i) } }));
        } else if (seen.has(s.vic)) {
          out.push(issue("svd.duplicate", `VIC ${s.vic} is listed more than once.`, { where, fix: { label: "Remove the duplicate", apply: (e) => removeSvd(e, extension, index, i) } }));
        }
        seen.add(s.vic);
      });
      svdCount += b.svds.length;
    });
  }

  for (const { cta, extension } of blocks) {
    cta.dataBlocks.forEach((b, index) => {
      if (b.kind !== "ycbcr420CapabilityMap" || b.bitmap.length === 0) return;
      let highest = -1;
      b.bitmap.forEach((v, i) => {
        for (let j = 0; j < 8; j++) if ((v >> j) & 1) highest = i * 8 + j;
      });
      if (highest >= svdCount) {
        out.push(
          issue("y420.map-length", `The 4:2:0 capability map flags SVD ${highest + 1}, but there are only ${svdCount} SVDs.`, {
            where: { type: "dataBlock", extension, index },
            fix: {
              label: "Clear the bits past the last SVD",
              apply: (e) => ({
                ...e,
                extensions: e.extensions.map((x, xi) =>
                  xi === extension && x.kind === "cta"
                    ? { ...x, dataBlocks: x.dataBlocks.map((y, yi) => (yi === index && y.kind === "ycbcr420CapabilityMap" ? { ...y, bitmap: y.bitmap.map((v, k) => v & maskBelow(svdCount - k * 8)) } : y)) }
                    : x,
                ),
              }),
            },
          }),
        );
      }
    });
  }

  const vga = ESTABLISHED_TIMINGS.find((t) => t.label === "640x480 @ 60 Hz");
  const has640 =
    (vga !== undefined && isEstablishedSet(edid.base.establishedTimings, vga)) ||
    blocks.some(({ cta }) => cta.dataBlocks.some((b) => b.kind === "video" && b.svds.some((s) => s.vic === 1)));
  if (!has640) {
    out.push(
      issue("cta.640x480", "640x480 @ 60 Hz is not listed. CTA-861 requires it and edid-decode fails without it; leaving it out is fine when the EDID should hold one mode only.", {
        where: { type: "establishedTimings" },
        fix: { label: "Add 640x480 @ 60 Hz", apply: (e) => ({ ...e, base: { ...e.base, establishedTimings: [e.base.establishedTimings[0] | 0x20, e.base.establishedTimings[1], e.base.establishedTimings[2]] } }) },
      }),
    );
  }
  return out;
}

/** Bytes an HDMI VSDB's flags byte promises after itself (HDMI 1.4b table 8-16; edid-decode cta_hdmi_block()). */
function hdmiTailNeeds(tail: readonly number[]): number {
  const flags = tail[0];
  if (flags === undefined) return 0;
  let n = 1;
  if (flags & 0x80) n += 2;
  if (flags & 0x80 && flags & 0x40) n += 2;
  if (flags & 0x20) {
    const lens = tail[n + 1];
    n += 2;
    if (lens === undefined) return n;
    n += (lens >> 5) + (lens & 0x1f);
  }
  return n;
}

/** HDMI VICs listed in an HDMI VSDB tail (HDMI 1.4b table 8-16). */
function hdmiVics(tail: readonly number[]): number[] {
  const flags = tail[0];
  if (flags === undefined || !(flags & 0x20)) return [];
  let n = 1 + (flags & 0x80 ? 2 : 0) + (flags & 0x80 && flags & 0x40 ? 2 : 0);
  const lens = tail[n + 1];
  if (lens === undefined) return [];
  n += 2;
  return tail.slice(n, n + (lens >> 5));
}

function hdmiRules(edid: Edid): Issue[] {
  const out: Issue[] = [];
  const blocks = ctaBlocks(edid);
  let vsdb: { b: HdmiVsdb; extension: number; index: number } | undefined;
  let forum: { scdc: boolean; rateKHz: number } | undefined;
  for (const { cta, extension } of blocks) {
    cta.dataBlocks.forEach((b, index) => {
      if (b.kind === "hdmiVsdb" && !vsdb) vsdb = { b, extension, index };
      if (b.kind === "hdmiForumVsdb" && !forum) forum = { scdc: b.scdcPresent, rateKHz: b.maxTmdsCharRate5MHz * 5000 };
    });
  }
  if (!vsdb) return out;
  const where: NodeRef = { type: "dataBlock", extension: vsdb.extension, index: vsdb.index };

  if (edid.base.revision >= 4) out.push(issue("hdmi.edid-version", "The HDMI specification requires EDID 1.3; this HDMI EDID is 1.4.", { where: { type: "baseVersion" } }));

  const needs = hdmiTailNeeds(vsdb.b.tail);
  if (needs > vsdb.b.tail.length) {
    out.push(issue("hdmi.vsdb-structure", `The HDMI VSDB flags promise ${needs - vsdb.b.tail.length} more byte(s) than the block holds.`, { where }));
  }

  // HDMI VIC n stands for CTA VIC 95, 94, 93, 98 (edid-decode edid_hdmi_mode_map).
  const HDMI_VIC_TO_CTA = [95, 94, 93, 98];
  const listed = new Set(blocks.flatMap(({ cta }) => cta.dataBlocks.flatMap((b) => (b.kind === "video" ? b.svds.map((s) => s.vic) : []))));
  const missing = hdmiVics(vsdb.b.tail).filter((v) => !listed.has(HDMI_VIC_TO_CTA[v - 1] ?? -1));
  if (missing.length > 0) {
    out.push(
      issue("hdmi.vic-equivalents", `HDMI VIC${missing.length > 1 ? "s" : ""} ${missing.join(", ")} ${missing.length > 1 ? "need" : "needs"} CTA VIC ${missing.map((v) => HDMI_VIC_TO_CTA[v - 1] ?? `? (unknown HDMI VIC ${v})`).join(", ")} in the video data block.`, {
        where,
        fix: { label: "Remove the HDMI VICs", apply: (e) => removeHdmiVideo(e) },
      }),
    );
  }

  const vsdbKHz = (vsdb.b.maxTmdsClock5MHz ?? 0) * 5000;
  if (vsdbKHz > 340_000) {
    out.push(
      issue("hdmi.vsdb-tmds", `The HDMI VSDB states ${vsdbKHz / 1000} MHz; this field stops at 340 MHz, and faster rates belong in the HDMI Forum VSDB.`, {
        where,
        fix: { label: "Set it to 340 MHz", apply: (e) => mapVsdb(e, (b) => ({ ...b, maxTmdsClock5MHz: 68 })) },
      }),
    );
  }

  const modes = listModes(edid);
  const fastest = modes.filter((m) => !m.only420).reduce((a, m) => Math.max(a, m.clockKHz), 0);
  const fastest420 = modes.filter((m) => m.only420).reduce((a, m) => Math.max(a, m.clockKHz / 2), 0);
  const needed = Math.max(fastest, fastest420);
  const stated = forum && forum.rateKHz > 0 ? forum.rateKHz : vsdbKHz;
  if (stated > 0 && needed > stated) {
    out.push(issue("hdmi.max-tmds", `The fastest mode needs ${(needed / 1000).toFixed(2)} MHz at 8-bit, above the stated maximum of ${stated / 1000} MHz.`, { where }));
  }
  if (fastest > 340_000 && !(forum && forum.scdc)) {
    out.push(issue("hdmi.forum-vsdb-needed", `A mode needs ${(fastest / 1000).toFixed(2)} MHz, above 340 MHz, which needs an HDMI Forum VSDB with SCDC present.`, { where }));
  }

  const caps = vsdb.b.capabilities;
  const ycc444 = blocks.some(({ cta }) => cta.ycbcr444);
  if (caps?.dcY444 && !ycc444) {
    out.push(
      issue("color.y444-flag", "DC_Y444 (deep colour for YCbCr 4:4:4) is set, but YCbCr 4:4:4 is not supported.", {
        where,
        fix: { label: "Clear DC_Y444", apply: (e) => setHdmiDeepColour(e, { dcY444: false }) },
      }),
    );
  } else if (caps?.dcY444 && !(caps.dc30bit || caps.dc36bit || caps.dc48bit)) {
    out.push(issue("color.y444-depth", "DC_Y444 is set without any deep colour depth.", { where, fix: { label: "Clear DC_Y444", apply: (e) => setHdmiDeepColour(e, { dcY444: false }) } }));
  }

  const adv = advertisedColour(edid);
  if (!adv.formats.includes("ycbcr420") && adv.depths420.length > 0) {
    out.push(
      issue("color.420-depth", "4:2:0 deep colour is set in the HDMI Forum VSDB, but no mode supports 4:2:0.", {
        where,
        fix: { label: "Clear the 4:2:0 deep colour flags", apply: (e) => setHf420DeepColour(e, { dc30bit420: false, dc36bit420: false, dc48bit420: false }) },
      }),
    );
  }
  return out;
}

function linkRules(edid: Edid, link: Link): Issue[] {
  const out: Issue[] = [];
  const reports = analyzeLink(edid, link);
  for (const r of reports) if (r.message !== "") out.push(issue("link.too-fast", r.message));

  // Contradiction: a deep colour depth no RGB mode can carry on this link (SPEC.md section 7).
  const adv = advertisedColour(edid);
  const modes = reports.filter((r) => !r.mode.includes("4:2:0 only"));
  if (modes.length > 0 && edid.extensions.some((e) => e.kind === "cta")) {
    for (const depth of adv.depths.filter((d) => d > 8)) {
      const usable = modes.some((m) => feasibility(m.pixelClockKHz, link).some((f) => f.format === "rgb" && f.depth === depth && f.fits));
      if (!usable) {
        const flag = depth === 10 ? "dc30bit" : depth === 12 ? "dc36bit" : "dc48bit";
        out.push(
          issue("link.depth-unusable", `${depth}-bit is advertised, but no listed mode can carry ${depth}-bit RGB on ${LINKS[link].name} (the slowest needs ${(tmdsRateKHz(Math.min(...modes.map((m) => m.pixelClockKHz)), "rgb", depth) / 1000).toFixed(2)} MHz).`, {
            fix: { label: `Stop advertising ${depth}-bit`, apply: (e) => setHdmiDeepColour(e, { [flag]: false }) },
          }),
        );
      }
    }
  }
  return out;
}

function mapVsdb(edid: Edid, f: (b: HdmiVsdb) => HdmiVsdb): Edid {
  return { ...edid, extensions: edid.extensions.map((e) => (e.kind === "cta" ? { ...e, dataBlocks: e.dataBlocks.map((b) => (b.kind === "hdmiVsdb" ? f(b) : b)) } : e)) };
}

function replaceAt(edid: Edid, at: { readonly extension?: number; readonly index: number }, d: Descriptor): Edid {
  if (at.extension === undefined) return { ...edid, base: { ...edid.base, descriptors: edid.base.descriptors.map((x, i) => (i === at.index ? d : x)) } };
  return {
    ...edid,
    extensions: edid.extensions.map((e, i) => (i === at.extension && e.kind === "cta" ? { ...e, descriptors: e.descriptors.map((x, j) => (j === at.index ? d : x)) } : e)),
  };
}

function maskBelow(bits: number): number {
  if (bits >= 8) return 0xff;
  if (bits <= 0) return 0;
  return (1 << bits) - 1;
}

function printableText(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, (c) => `\\x${hex(c.charCodeAt(0))}`).slice(0, 40);
}

function hex(v: number): string {
  return v.toString(16).padStart(2, "0");
}
