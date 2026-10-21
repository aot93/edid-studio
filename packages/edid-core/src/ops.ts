// Pure edit operations. Each returns a new model and leaves the input
// untouched; serializeEdid checks the result. Recipes (M3) will log these.

import { decodeStandardTiming, ESTABLISHED_TIMINGS, isEstablishedSet } from "./base-timings.ts";
import { describeDtd, lookupVic } from "./describe.ts";
import { EXT_HF_EEODB } from "./cta.ts";
import { describeDisplayIdTiming, displayIdSection, displayIdTimings, TYPE1_PREFERRED } from "./displayid.ts";
import { EdidEncodeError } from "./errors.ts";
import type { ColourFormat, Depth } from "./link.ts";
import type {
  CtaExtension,
  DataBlock,
  Descriptor,
  DetailedTimingDescriptor,
  DisplayIdDataBlock,
  DisplayIdTiming,
  Edid,
  HdmiForumVsdb,
  HdmiVsdbCapabilities,
  StandardTimingCode,
} from "./model.ts";

function mapCta(edid: Edid, f: (cta: CtaExtension, index: number) => CtaExtension): Edid {
  return { ...edid, extensions: edid.extensions.map((e, i) => (e.kind === "cta" ? f(e, i) : e)) };
}

function ctaAt(edid: Edid, extension: number): CtaExtension {
  const ext = edid.extensions[extension];
  if (ext?.kind !== "cta") throw new RangeError(`block ${extension + 1} is not a CTA-861 extension`);
  return ext;
}

/**
 * Sets the display product name (tag 0xfc, at most 13 characters of
 * printable ASCII). Replaces the existing name, or else the first dummy
 * descriptor in the base block.
 */
export function setMonitorName(edid: Edid, name: string): Edid {
  if (!/^[\x20-\x7e]{1,13}$/.test(name)) {
    throw new EdidEncodeError("monitor name", "monitor name must be 1 to 13 printable ASCII characters");
  }
  const ds = edid.base.descriptors;
  let at = ds.findIndex((d) => d.kind === "text" && d.tag === 0xfc);
  if (at === -1) at = ds.findIndex((d) => d.kind === "dummy");
  if (at === -1) {
    throw new EdidEncodeError("monitor name", "no name or dummy descriptor is free to hold a monitor name");
  }
  const descriptors: Descriptor[] = ds.map((d, i) => (i === at ? { kind: "text", tag: 0xfc, text: name } : d));
  return { ...edid, base: { ...edid.base, descriptors } };
}

export type HdmiDeepColour = Partial<Pick<HdmiVsdbCapabilities, "dc30bit" | "dc36bit" | "dc48bit" | "dcY444">>;

/** Sets deep-colour flags in every HDMI VSDB that has a capability byte. */
export function setHdmiDeepColour(edid: Edid, flags: HdmiDeepColour): Edid {
  let found = false;
  const out = mapCta(edid, (cta) => ({
    ...cta,
    dataBlocks: cta.dataBlocks.map((b) => {
      if (b.kind !== "hdmiVsdb" || b.capabilities === undefined) return b;
      found = true;
      return { ...b, capabilities: { ...b.capabilities, ...flags } };
    }),
  }));
  if (!found) throw new EdidEncodeError("HDMI VSDB", "no HDMI VSDB with a capability byte to hold deep-colour flags");
  return out;
}

export type Hf420DeepColour = Partial<Pick<HdmiForumVsdb, "dc30bit420" | "dc36bit420" | "dc48bit420">>;

/** Sets 4:2:0 deep-colour flags in every HDMI Forum VSDB. */
export function setHf420DeepColour(edid: Edid, flags: Hf420DeepColour): Edid {
  let found = false;
  const out = mapCta(edid, (cta) => ({
    ...cta,
    dataBlocks: cta.dataBlocks.map((b) => {
      if (b.kind !== "hdmiForumVsdb") return b;
      found = true;
      return { ...b, ...flags };
    }),
  }));
  if (!found) throw new EdidEncodeError("HDMI Forum VSDB", "no HDMI Forum VSDB to hold 4:2:0 deep-colour flags");
  return out;
}

/** Sets the YCbCr support flags in byte 3 of every CTA extension (they must agree). */
export function setCtaYcbcr(edid: Edid, flags: { readonly ycbcr444?: boolean; readonly ycbcr422?: boolean }): Edid {
  return mapCta(edid, (cta) => ({ ...cta, ...flags }));
}

/**
 * Removes one data block. Removing a video data block also removes its
 * SVDs from the 4:2:0 capability map (see `removeSvd`).
 */
export function removeDataBlock(edid: Edid, extension: number, block: number): Edid {
  const target = ctaAt(edid, extension).dataBlocks[block];
  if (target === undefined) throw new RangeError(`data block ${block} does not exist`);
  if (target.kind === "video" && target.svds.length > 0) {
    // Removing the last SVD removes the block itself.
    let out = edid;
    for (let i = target.svds.length - 1; i >= 0; i--) out = removeSvd(out, extension, block, i);
    return out;
  }
  return mapCta(edid, (cta, i) => (i === extension ? { ...cta, dataBlocks: cta.dataBlocks.filter((_, j) => j !== block) } : cta));
}

/**
 * Removes one SVD and keeps the YCbCr 4:2:0 capability map pointing at the
 * same VICs. Map bit n refers to the n-th SVD across every video data block
 * in every CTA extension, LSB first (edid-decode cta_y420cmdb()). A map left
 * with no bits is removed, since an empty map would mean "all SVDs". A video
 * data block left empty is removed.
 */
export function removeSvd(edid: Edid, extension: number, block: number, svd: number): Edid {
  const vdb = ctaAt(edid, extension).dataBlocks[block];
  if (vdb?.kind !== "video" || vdb.svds[svd] === undefined) throw new RangeError("SVD does not exist");

  let globalIndex = 0;
  edid.extensions.forEach((e, ei) => {
    if (e.kind !== "cta") return;
    e.dataBlocks.forEach((b, bi) => {
      if (b.kind !== "video") return;
      if (ei < extension || (ei === extension && bi < block)) globalIndex += b.svds.length;
    });
  });
  globalIndex += svd;

  return mapCta(edid, (cta, ei) => {
    const dataBlocks: DataBlock[] = [];
    cta.dataBlocks.forEach((b, bi) => {
      if (ei === extension && bi === block && b.kind === "video") {
        const svds = b.svds.filter((_, i) => i !== svd);
        if (svds.length > 0) dataBlocks.push({ ...b, svds });
      } else if (b.kind === "ycbcr420CapabilityMap" && b.bitmap.length > 0) {
        const bitmap = dropBit(b.bitmap, globalIndex);
        if (bitmap.some((v) => v !== 0)) dataBlocks.push({ ...b, bitmap });
      } else {
        dataBlocks.push(b);
      }
    });
    return { ...cta, dataBlocks };
  });
}

/** Removes bit `index` (LSB-first across bytes) and shifts later bits down. Length is kept. */
function dropBit(bitmap: readonly number[], index: number): number[] {
  const bits = bitmap.flatMap((byte) => [0, 1, 2, 3, 4, 5, 6, 7].map((j) => (byte >> j) & 1));
  bits.splice(index, 1);
  bits.push(0);
  return bitmap.map((_, i) => bits.slice(i * 8, i * 8 + 8).reduce((acc, bit, j) => acc | (bit << j), 0));
}

// ---------------------------------------------------------------------------
// Mode, timing, colour and range-limit operations (SPEC.md section 9).

const DUMMY: Descriptor = { kind: "dummy" };

/** Replaces the eight standard timings (two bytes each; 01 01 marks an unused slot). */
export function setStandardTimings(edid: Edid, codes: readonly StandardTimingCode[]): Edid {
  if (codes.length !== 8) throw new EdidEncodeError("standard timings", `${codes.length} standard timings given, expected 8`);
  return { ...edid, base: { ...edid.base, standardTimings: codes.map(([a, b]) => [a, b] as const) } };
}

/** Replaces the established timings bytes (block 0 bytes 0x23 to 0x25). */
export function setEstablishedTimings(edid: Edid, bytes: readonly [number, number, number]): Edid {
  return { ...edid, base: { ...edid.base, establishedTimings: [bytes[0], bytes[1], bytes[2]] } };
}

/**
 * Removes the HDMI video fields from every HDMI VSDB: the HDMI_Video_present
 * flag, HDMI VICs and 3D data. Latency fields stay. Layout: HDMI 1.4b table
 * 8-16; edid-decode cta_hdmi_block().
 */
export function removeHdmiVideo(edid: Edid): Edid {
  return mapCta(edid, (cta) => ({
    ...cta,
    dataBlocks: cta.dataBlocks.map((b) => {
      if (b.kind !== "hdmiVsdb" || b.tail.length === 0) return b;
      const flags = b.tail[0] ?? 0;
      if (!(flags & 0x20)) return b;
      const latency = (flags & 0x80 ? 2 : 0) + (flags & 0x80 && flags & 0x40 ? 2 : 0);
      return { ...b, tail: [flags & ~0x20, ...b.tail.slice(1, 1 + latency)] };
    }),
  }));
}

/**
 * Removes every video mode except the listed VICs: detailed timings (base
 * slots become dummies, CTA DTDs are dropped), established and standard
 * timings, SVDs, 4:2:0-only SVDs and HDMI VICs. The 4:2:0 capability map
 * follows the remaining SVDs and goes when none remain; an empty video data
 * block goes too.
 */
export function keepOnlyModes(edid: Edid, keep: { readonly vics: readonly number[] } = { vics: [] }): Edid {
  let out: Edid = {
    ...edid,
    base: {
      ...edid.base,
      establishedTimings: [0, 0, 0],
      standardTimings: new Array<StandardTimingCode>(8).fill([0x01, 0x01]),
      descriptors: edid.base.descriptors.map((d) => (d.kind === "dtd" ? DUMMY : d)),
    },
  };
  out = mapCta(out, (cta) => ({ ...cta, descriptors: cta.descriptors.filter((d) => d.kind !== "dtd") }));
  out = removeHdmiVideo(out);

  // Remove SVDs from the end so earlier indexes stay valid.
  for (let e = out.extensions.length - 1; e >= 0; e--) {
    const cta = out.extensions[e];
    if (cta?.kind !== "cta") continue;
    for (let b = cta.dataBlocks.length - 1; b >= 0; b--) {
      const block = ctaAt(out, e).dataBlocks[b];
      if (block?.kind !== "video") continue;
      for (let s = block.svds.length - 1; s >= 0; s--) {
        const svd = block.svds[s];
        if (svd && !keep.vics.includes(svd.vic)) out = removeSvd(out, e, b, s);
      }
    }
  }

  const anySvds = out.extensions.some((e) => e.kind === "cta" && e.dataBlocks.some((b) => b.kind === "video"));
  return mapCta(out, (cta) => ({
    ...cta,
    dataBlocks: cta.dataBlocks.flatMap((b): DataBlock[] => {
      if (b.kind === "ycbcr420CapabilityMap" && !anySvds) return [];
      if (b.kind === "ycbcr420Video") {
        const svds = b.svds.filter((s) => keep.vics.includes(s.vic));
        return svds.length > 0 ? [{ ...b, svds }] : [];
      }
      return [b];
    }),
  }));
}

/**
 * Puts a detailed timing in the first base descriptor, where it is the
 * preferred timing. Replaces a DTD or dummy there; otherwise moves that
 * descriptor into a free dummy slot first.
 */
export function setPreferredTiming(edid: Edid, dtd: DetailedTimingDescriptor): Edid {
  const ds = [...edid.base.descriptors];
  const first = ds[0];
  if (first && first.kind !== "dtd" && first.kind !== "dummy") {
    const free = ds.findIndex((d, i) => i > 0 && d.kind === "dummy");
    if (free === -1) throw new EdidEncodeError("preferred timing", "no free descriptor slot to make room for the preferred timing");
    ds[free] = first;
  }
  ds[0] = dtd;
  return { ...edid, base: { ...edid.base, descriptors: ds } };
}

/** Adds a detailed timing: a free base descriptor slot first, otherwise the first CTA extension. */
export function addDetailedTiming(edid: Edid, dtd: DetailedTimingDescriptor): Edid {
  const free = edid.base.descriptors.findIndex((d) => d.kind === "dummy");
  if (free !== -1) {
    return { ...edid, base: { ...edid.base, descriptors: edid.base.descriptors.map((d, i) => (i === free ? dtd : d)) } };
  }
  const first = edid.extensions.findIndex((e) => e.kind === "cta");
  if (first === -1) throw new EdidEncodeError("detailed timing", "no free descriptor slot and no CTA-861 extension to hold another timing");
  return mapCta(edid, (cta, i) => (i === first ? { ...cta, descriptors: [...cta.descriptors, dtd] } : cta));
}

/**
 * Adds a DisplayID Type I timing, for rasters a DTD cannot hold, as the
 * preferred DisplayID timing. Appends to the first typed DisplayID section,
 * or adds a section after the last extension. On EDID 1.3 a third block
 * needs an HDMI Forum EEODB in block 1 (edid-decode check_base_block()), so
 * one is added or its count updated; the base block's DTD stays as the
 * fallback for sources that ignore DisplayID.
 */
export function addDisplayIdTiming(edid: Edid, timing: DisplayIdTiming): Edid {
  const added = { ...timing, flags: timing.flags | TYPE1_PREFERRED };
  // Bit 7 means preferred only below block revision 2 (edid-decode parse_displayid_type_1_7_timing()).
  const unprefer = (b: DisplayIdDataBlock): DisplayIdDataBlock =>
    b.kind === "type1Timings" && (b.revision & 0x07) < 2 ? { ...b, timings: b.timings.map((t) => ({ ...t, flags: t.flags & ~TYPE1_PREFERRED })) } : b;
  const at = edid.extensions.findIndex((e) => e.kind === "displayid");
  const extensions =
    at === -1
      ? [...edid.extensions, displayIdSection([added])]
      : edid.extensions.map((e, i) => {
          if (e.kind !== "displayid") return e;
          const blocks = e.dataBlocks.map(unprefer);
          if (i !== at) return { ...e, dataBlocks: blocks };
          const t1 = blocks.findIndex((b) => b.kind === "type1Timings" && (b.revision & 0x07) < 2);
          const grown: DisplayIdDataBlock[] =
            t1 === -1
              ? [...blocks, { kind: "type1Timings", revision: 0, timings: [added] }]
              : blocks.map((b, j) => (j === t1 && b.kind === "type1Timings" ? { ...b, timings: [...b.timings, added] } : b));
          // Zero filler inside the section makes room first, so a full 121-byte section stays 121 bytes.
          return { ...e, dataBlocks: grown, filler: Math.max(0, e.filler - (t1 === -1 ? 23 : 20)) };
        });
  return withEeodb({ ...edid, extensions });
}

/** Keeps an HDMI Forum EEODB in block 1 in step with the extension count, adding one where EDID 1.3 needs it. */
function withEeodb(edid: Edid): Edid {
  const first = edid.extensions[0];
  if (first?.kind !== "cta") return edid;
  const count = edid.extensions.length;
  const isEeodb = (b: DataBlock) => b.kind === "raw" && (b.bytes[0] ?? 0) >> 5 === 7 && b.bytes[1] === EXT_HF_EEODB;
  const eeodb: DataBlock = { kind: "raw", bytes: [(7 << 5) | 2, EXT_HF_EEODB, count] };
  let dataBlocks = first.dataBlocks;
  if (dataBlocks.some(isEeodb)) dataBlocks = dataBlocks.map((b) => (isEeodb(b) ? eeodb : b));
  else if (edid.base.version === 1 && edid.base.revision === 3 && count > 1) dataBlocks = [eeodb, ...dataBlocks];
  else return edid;
  return { ...edid, extensions: [{ ...first, dataBlocks }, ...edid.extensions.slice(1)] };
}

/** Replaces the descriptor at a base slot or a CTA descriptor index. */
export function replaceDescriptor(edid: Edid, where: { readonly extension?: number; readonly index: number }, d: Descriptor): Edid {
  if (where.extension === undefined) {
    if (edid.base.descriptors[where.index] === undefined) throw new RangeError(`no base descriptor ${where.index}`);
    return { ...edid, base: { ...edid.base, descriptors: edid.base.descriptors.map((x, i) => (i === where.index ? d : x)) } };
  }
  const cta = ctaAt(edid, where.extension);
  if (cta.descriptors[where.index] === undefined) throw new RangeError(`no CTA descriptor ${where.index}`);
  return mapCta(edid, (c, i) => (i === where.extension ? { ...c, descriptors: c.descriptors.map((x, j) => (j === where.index ? d : x)) } : c));
}

/** Removes a detailed timing: a base slot becomes a dummy, a CTA DTD is dropped. */
export function removeDescriptor(edid: Edid, where: { readonly extension?: number; readonly index: number }): Edid {
  if (where.extension === undefined) return replaceDescriptor(edid, where, DUMMY);
  ctaAt(edid, where.extension);
  return mapCta(edid, (c, i) => (i === where.extension ? { ...c, descriptors: c.descriptors.filter((_, j) => j !== where.index) } : c));
}

const DEPTH_CODES: Record<number, number> = { 6: 1, 8: 2, 10: 3, 12: 4, 14: 5, 16: 6 };

/**
 * Sets colour formats and depths together (SPEC.md section 9): CTA YCbCr
 * flags, HDMI VSDB deep colour, HDMI Forum VSDB 4:2:0 deep colour, and the
 * base-block bit depth on EDID 1.4. Without 4:2:0, the 4:2:0 capability map
 * and 4:2:0-only modes are removed, so nothing advertises it.
 */
export function setColor(edid: Edid, formats: readonly ColourFormat[], requested: readonly Depth[]): Edid {
  if (!formats.includes("rgb")) throw new EdidEncodeError("colour formats", "RGB is mandatory for HDMI and DVI sinks");
  // 8-bit is always supported on HDMI and DVI, so it is implied: [10] means 8 and 10-bit.
  const depths: readonly Depth[] = requested.includes(8) ? requested : [8, ...requested];
  const has = (d: Depth) => depths.includes(d);
  const deep = depths.some((d) => d > 8);
  const y444 = formats.includes("ycbcr444");
  const y420 = formats.includes("ycbcr420");

  let out = mapCta(edid, (cta) => ({
    ...cta,
    ycbcr444: y444,
    ycbcr422: formats.includes("ycbcr422"),
    dataBlocks: cta.dataBlocks.flatMap((b): DataBlock[] => {
      if (!y420 && (b.kind === "ycbcr420CapabilityMap" || b.kind === "ycbcr420Video")) return [];
      if (b.kind === "hdmiVsdb") {
        const caps = b.capabilities ?? { supportsAi: false, dc48bit: false, dc36bit: false, dc30bit: false, dcY444: false, reserved: 0, dviDual: false };
        if (!deep && b.capabilities === undefined) return [b];
        return [{ ...b, capabilities: { ...caps, dc30bit: has(10), dc36bit: has(12), dc48bit: has(16), dcY444: y444 && deep } }];
      }
      if (b.kind === "hdmiForumVsdb") {
        return [{ ...b, dc30bit420: y420 && has(10), dc36bit420: y420 && has(12), dc48bit420: y420 && has(16) }];
      }
      return [b];
    }),
  }));

  // EDID 1.4 digital input: bits 6-4 hold the bit depth (E-EDID 1.4 table 3.11).
  const vi = out.base.videoInput;
  if (out.base.version === 1 && out.base.revision >= 4 && vi & 0x80) {
    const max = Math.max(...depths);
    out = { ...out, base: { ...out.base, videoInput: (vi & 0x8f) | ((DEPTH_CODES[max] ?? 0) << 4) } };
  }
  return out;
}

export interface RangeLimitsSpec {
  readonly vHz: readonly [number, number];
  readonly hKHz: readonly [number, number];
  readonly maxClockMHz: number;
  /** "none": range limits only (byte 10 = 0x01); "default": default GTF (0x00). */
  readonly gtf: "none" | "default";
}

/**
 * Writes the display range limits descriptor (E-EDID 1.4 section 3.10.3.3).
 * The maximum clock is rounded up to a multiple of 10 MHz. Uses the existing
 * range limits slot, or else a dummy slot.
 */
export function setRangeLimits(edid: Edid, spec: RangeLimitsSpec): Edid {
  const values: [string, number][] = [
    ["minimum vertical rate", spec.vHz[0]],
    ["maximum vertical rate", spec.vHz[1]],
    ["minimum horizontal rate", spec.hKHz[0]],
    ["maximum horizontal rate", spec.hKHz[1]],
  ];
  for (const [name, v] of values) {
    // TODO(verify): rates above 255 need the EDID 1.4 offset flags; not supported yet.
    if (!Number.isInteger(v) || v < 1 || v > 255) throw new EdidEncodeError(name, `${name} ${v} must be a whole number from 1 to 255`);
  }
  if (spec.vHz[0] > spec.vHz[1] || spec.hKHz[0] > spec.hKHz[1]) {
    throw new EdidEncodeError("range limits", "each minimum must not exceed its maximum");
  }
  const clock = Math.ceil(spec.maxClockMHz / 10);
  if (clock < 1 || clock > 255) throw new EdidEncodeError("maximum pixel clock", `maximum pixel clock ${spec.maxClockMHz} MHz must be 10 to 2550 MHz`);
  const d: Descriptor = {
    kind: "rangeLimits",
    offsetFlags: 0,
    minVerticalHz: spec.vHz[0],
    maxVerticalHz: spec.vHz[1],
    minHorizontalKHz: spec.hKHz[0],
    maxHorizontalKHz: spec.hKHz[1],
    maxPixelClock10MHz: clock,
    timingSupport: spec.gtf === "none" ? 0x01 : 0x00,
    timingData: [0x0a, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20],
  };
  const ds = edid.base.descriptors;
  let at = ds.findIndex((x) => x.kind === "rangeLimits");
  if (at === -1) at = ds.findIndex((x) => x.kind === "dummy");
  if (at === -1) throw new EdidEncodeError("range limits", "no range limits or dummy descriptor slot is free");
  return { ...edid, base: { ...edid.base, descriptors: ds.map((x, i) => (i === at ? d : x)) } };
}

/**
 * Range limits that cover every established timing, detailed timing
 * (DisplayID Type I included) and listed VIC, plus the refresh of every standard timing: vertical
 * and horizontal rates rounded outward, maximum clock rounded up to 10 MHz
 * (SPEC.md section 8).
 */
export function autoRangeLimits(edid: Edid, gtf: RangeLimitsSpec["gtf"] = "none"): RangeLimitsSpec | undefined {
  const modes: { clockKHz: number; hKHz: number; refreshHz: number }[] = [];
  for (const t of ESTABLISHED_TIMINGS) {
    if (isEstablishedSet(edid.base.establishedTimings, t)) modes.push({ clockKHz: t.clockKHz, hKHz: t.hKHz, refreshHz: t.refreshHz });
  }
  const dtds = [...edid.base.descriptors, ...edid.extensions.flatMap((e) => (e.kind === "cta" ? e.descriptors : []))];
  const infos = [...dtds.flatMap((d) => (d.kind === "dtd" ? [describeDtd(d)] : [])), ...displayIdTimings(edid).map(describeDisplayIdTiming)];
  for (const info of infos) {
    modes.push({ clockKHz: info.pixelClockKHz, hKHz: info.pixelClockKHz / info.hTotal, refreshHz: info.refreshHz });
  }
  for (const e of edid.extensions) {
    if (e.kind !== "cta") continue;
    for (const b of e.dataBlocks) {
      if (b.kind !== "video") continue;
      for (const s of b.svds) {
        const v = lookupVic(s.vic);
        if (v) modes.push({ clockKHz: v.pixelClockKHz, hKHz: v.pixelClockKHz / v.hTotal, refreshHz: v.refreshHz });
      }
    }
  }
  if (modes.length === 0) return undefined;
  const hKHz = modes.map((m) => m.hKHz);
  // Standard timings state their refresh exactly; their line rate depends on GTF or CVT, so they set only the vertical range.
  const refreshes = [...modes.map((m) => m.refreshHz), ...edid.base.standardTimings.flatMap((c) => decodeStandardTiming(c)?.refreshHz ?? [])];
  return {
    vHz: [Math.floor(Math.min(...refreshes)), Math.ceil(Math.max(...refreshes))],
    hKHz: [Math.floor(Math.min(...hKHz)), Math.ceil(Math.max(...hKHz))],
    maxClockMHz: Math.ceil(Math.max(...modes.map((m) => m.clockKHz)) / 10_000) * 10,
    gtf,
  };
}

/**
 * Makes an existing detailed timing the preferred one by swapping it with
 * base descriptor 0. A timing that was preferred takes the other's place;
 * anything else in slot 0 moves to a free dummy slot (setPreferredTiming).
 */
export function makePreferred(edid: Edid, where: { readonly extension?: number; readonly index: number }): Edid {
  const target = where.extension === undefined ? edid.base.descriptors[where.index] : ctaAt(edid, where.extension).descriptors[where.index];
  if (target?.kind !== "dtd") throw new RangeError("that descriptor is not a detailed timing");
  if (where.extension === undefined && where.index === 0) return edid;
  const first = edid.base.descriptors[0];
  if (first?.kind === "dtd") {
    return setPreferredTiming(replaceDescriptor(edid, where, first), target);
  }
  return setPreferredTiming(removeDescriptor(edid, where), target);
}
