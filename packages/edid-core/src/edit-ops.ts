// Identity, HDMI, audio and mode-list operations (SPEC.md section 9). Pure:
// each returns a new model; serializeEdid checks the result.

import { decodeStandardTiming, ESTABLISHED_TIMINGS, isEstablishedSet, UNUSED_STANDARD_TIMING } from "./base-timings.ts";
import { encodeManufacturerId } from "./base-block.ts";
import { describeDtd, lookupVic } from "./describe.ts";
import { describeDisplayIdTiming } from "./displayid.ts";
import { EdidEncodeError } from "./errors.ts";
import type { CtaExtension, DataBlock, Descriptor, DisplayIdDataBlock, Edid, Extension, HdmiForumVsdb, TextDescriptorTag } from "./model.ts";
import { addDetailedTiming, addDisplayIdTiming, removeSvd, setMonitorName, withEeodb } from "./ops.ts";
import { buildTiming } from "./timing.ts";
import type { Formula, Rb3Options } from "./timing.ts";

function mapCta(edid: Edid, f: (cta: CtaExtension) => CtaExtension): Edid {
  return { ...edid, extensions: edid.extensions.map((e) => (e.kind === "cta" ? f(e) : e)) };
}

function inRange(field: string, v: number, min: number, max: number): number {
  if (!Number.isInteger(v) || v < min || v > max) throw new EdidEncodeError(field, `${field} ${v} must be a whole number from ${min} to ${max}`);
  return v;
}

// ---------------------------------------------------------------------------
// Identity

export interface Identity {
  /** Three letters A-Z. */
  readonly manufacturerId?: string;
  /** 0 to 65535. */
  readonly productCode?: number;
  /** Numeric serial, bytes 12-15. */
  readonly serialNumber?: number;
  /** Monitor name descriptor (0xfc), up to 13 characters. */
  readonly name?: string;
  /** Serial number descriptor (0xff), up to 13 characters. */
  readonly serialText?: string;
  /** Week of manufacture, 1 to 54, or 0 for unspecified (E-EDID 1.4 section 3.4.4). */
  readonly week?: number;
  /** Year of manufacture, 1990 to 2245. */
  readonly year?: number;
}

/** Sets any of manufacturer, product code, serial, name, serial text, week and year. */
export function setIdentity(edid: Edid, id: Identity): Edid {
  let base = edid.base;
  if (id.manufacturerId !== undefined) base = { ...base, manufacturerCode: encodeManufacturerId(id.manufacturerId) };
  if (id.productCode !== undefined) base = { ...base, productCode: inRange("product code", id.productCode, 0, 0xffff) };
  if (id.serialNumber !== undefined) base = { ...base, serialNumber: inRange("serial number", id.serialNumber, 0, 0xffffffff) };
  if (id.week !== undefined) base = { ...base, week: inRange("week", id.week, 0, 54) };
  if (id.year !== undefined) base = { ...base, yearOffset: inRange("year", id.year, 1990, 2245) - 1990 };
  let out: Edid = { ...edid, base };
  if (id.name !== undefined) out = setMonitorName(out, id.name);
  if (id.serialText !== undefined) out = setText(out, 0xff, id.serialText, "serial text");
  return out;
}

/** Puts text in the descriptor with this tag, or in a free dummy slot. */
function setText(edid: Edid, tag: TextDescriptorTag, text: string, field: string): Edid {
  if (text.length > 13) throw new EdidEncodeError(field, `${field} is ${text.length} characters; the limit is 13`);
  if (!/^[\x20-\x7e]*$/.test(text)) throw new EdidEncodeError(field, `${field} must be printable ASCII`);
  const ds = edid.base.descriptors;
  let at = ds.findIndex((d) => d.kind === "text" && d.tag === tag);
  if (at === -1) at = ds.findIndex((d) => d.kind === "dummy");
  if (at === -1) throw new EdidEncodeError(field, `no free descriptor slot for the ${field}`);
  const d: Descriptor = { kind: "text", tag, text };
  return { ...edid, base: { ...edid.base, descriptors: ds.map((x, i) => (i === at ? d : x)) } };
}

/**
 * Per-output serial for sets (SPEC.md section 9): the numeric serial, and the
 * serial text descriptor when there is one, so every output of a wall
 * reports a distinct display.
 */
export function setSerial(edid: Edid, serial: number): Edid {
  const out: Edid = { ...edid, base: { ...edid.base, serialNumber: inRange("serial number", serial, 0, 0xffffffff) } };
  return out.base.descriptors.some((d) => d.kind === "text" && d.tag === 0xff) ? setText(out, 0xff, String(serial), "serial text") : out;
}

// ---------------------------------------------------------------------------
// HDMI capabilities

export interface HdmiCaps {
  /** Highest TMDS rate the sink takes, in MHz, up to 600 (HDMI 2.0). */
  readonly maxTmdsMHz?: number;
  /** SCDC present (HDMI Forum VSDB). */
  readonly scdc?: boolean;
  /** Source physical address "A.B.C.D", each 0 to 15. */
  readonly physicalAddress?: string;
}

/**
 * Sets max TMDS, SCDC and the physical address. Up to 340 MHz is stated in
 * the HDMI VSDB; above that the HDMI VSDB says 340 and the HDMI Forum VSDB
 * the real rate (HDMI 2.0 section 10.3.2; edid-decode cta_hdmi_block(),
 * cta_hf_scdb()). An HDMI Forum VSDB is added right after the HDMI VSDB when
 * needed, as edid-decode requires that order.
 */
export function setHdmiCaps(edid: Edid, caps: HdmiCaps): Edid {
  const has = edid.extensions.some((e) => e.kind === "cta" && e.dataBlocks.some((b) => b.kind === "hdmiVsdb"));
  if (!has) throw new EdidEncodeError("HDMI capabilities", "this EDID has no HDMI VSDB; it describes a DVI sink");
  let pa: number | undefined;
  if (caps.physicalAddress !== undefined) {
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{1,2})\.(\d{1,2})$/.exec(caps.physicalAddress);
    const parts = m ? m.slice(1).map(Number) : [];
    if (parts.length !== 4 || parts.some((v) => v > 15)) {
      throw new EdidEncodeError("physical address", `physical address "${caps.physicalAddress.slice(0, 20)}" must be A.B.C.D with each part 0 to 15`);
    }
    pa = parts.reduce((a, v) => (a << 4) | v, 0);
  }
  const mhz = caps.maxTmdsMHz;
  if (mhz !== undefined && (!(mhz > 0) || mhz > 600)) throw new EdidEncodeError("max TMDS", `max TMDS ${mhz} MHz must be above 0 and at most 600`);
  const needForum = (mhz !== undefined && mhz > 340) || caps.scdc === true;
  const forumRate5MHz = mhz !== undefined && mhz > 340 ? Math.ceil(mhz / 5) : 0;

  let done = false;
  return mapCta(edid, (cta) => {
    const blocks: DataBlock[] = [];
    let hadForum = cta.dataBlocks.some((b) => b.kind === "hdmiForumVsdb");
    for (const b of cta.dataBlocks) {
      if (b.kind === "hdmiVsdb" && !done) {
        done = true;
        blocks.push({
          ...b,
          ...(pa !== undefined ? { physicalAddress: pa } : {}),
          ...(mhz !== undefined ? { maxTmdsClock5MHz: Math.ceil(Math.min(mhz, 340) / 5) } : {}),
        });
        if (needForum && !hadForum) {
          blocks.push({ ...forumVsdb(), maxTmdsCharRate5MHz: forumRate5MHz, scdcPresent: caps.scdc ?? true });
          hadForum = true;
        }
        continue;
      }
      if (b.kind === "hdmiForumVsdb") {
        blocks.push({
          ...b,
          ...(mhz !== undefined ? { maxTmdsCharRate5MHz: forumRate5MHz } : {}),
          ...(caps.scdc !== undefined ? { scdcPresent: caps.scdc } : {}),
        });
        continue;
      }
      blocks.push(b);
    }
    return { ...cta, dataBlocks: blocks };
  });
}

function forumVsdb(): HdmiForumVsdb {
  return {
    kind: "hdmiForumVsdb",
    version: 1,
    maxTmdsCharRate5MHz: 0,
    scdcPresent: false,
    scdcReadRequest: false,
    cableStatus: false,
    ccbpci: false,
    lte340McscScramble: false,
    independentView3d: false,
    dualView3d: false,
    osdDisparity3d: false,
    maxFrlRate: 0,
    uhdVic: false,
    dc48bit420: false,
    dc36bit420: false,
    dc30bit420: false,
    tail: [],
  };
}

// ---------------------------------------------------------------------------
// Audio

export type LpcmRate = 32 | 44.1 | 48 | 88.2 | 96 | 176.4 | 192;
export type LpcmDepth = 16 | 20 | 24;

/** Sample-rate bits, bit 0 first (edid-decode cta_audio_block()). */
const RATE_BITS: readonly number[] = [32, 44.1, 48, 88.2, 96, 176.4, 192];
const DEPTH_BITS: readonly number[] = [16, 20, 24];
/** Speakers for common layouts: 2.0 FL/FR; 5.1 adds LFE1, FC, LS/RS; 7.1 adds BL/BR (edid-decode cta_speaker_map). */
const SPEAKERS: Record<number, number> = { 2: 0x01, 6: 0x0f, 8: 0x4f };

export interface LpcmAudio {
  /** 2 (stereo), 6 (5.1) or 8 (7.1). */
  readonly channels: number;
  readonly ratesKHz: readonly number[];
  readonly depths: readonly number[];
}

/**
 * Replaces the audio and speaker allocation blocks with one LPCM short audio
 * descriptor and the matching speaker layout, and sets the basic audio flag
 * (edid-decode fails audio blocks without it).
 */
export function setAudio(edid: Edid, audio: LpcmAudio): Edid {
  const speakers = SPEAKERS[audio.channels];
  if (speakers === undefined) throw new EdidEncodeError("audio channels", `${audio.channels} channels: choose 2, 6 (5.1) or 8 (7.1)`);
  const rates = audio.ratesKHz.reduce((a, r) => {
    const bit = RATE_BITS.indexOf(r);
    if (bit === -1) throw new EdidEncodeError("audio sample rate", `${r} kHz is not an LPCM sample rate (32, 44.1, 48, 88.2, 96, 176.4 or 192)`);
    return a | (1 << bit);
  }, 0);
  const depths = audio.depths.reduce((a, d) => {
    const bit = DEPTH_BITS.indexOf(d);
    if (bit === -1) throw new EdidEncodeError("audio sample size", `${d}-bit is not an LPCM sample size (16, 20 or 24)`);
    return a | (1 << bit);
  }, 0);
  if (rates === 0 || depths === 0) throw new EdidEncodeError("audio", "give at least one sample rate and one sample size");
  const audioBlocks: DataBlock[] = [
    { kind: "audio", sads: [[(1 << 3) | (audio.channels - 1), rates, depths]] },
    { kind: "speakerAllocation", speakers },
  ];
  if (!edid.extensions.some((e) => e.kind === "cta")) throw new EdidEncodeError("audio", "audio needs a CTA-861 extension");
  let first = true;
  return mapCta(stripAudio(edid), (cta) => {
    if (!first) return cta;
    first = false;
    return { ...cta, basicAudio: true, dataBlocks: [...audioBlocks, ...cta.dataBlocks] };
  });
}

/** Removes audio and speaker allocation blocks (typed or raw) and clears the basic audio flag. */
export function stripAudio(edid: Edid): Edid {
  const isAudio = (b: DataBlock) => b.kind === "audio" || b.kind === "speakerAllocation" || (b.kind === "raw" && [1, 4].includes((b.bytes[0] ?? 0) >> 5));
  return mapCta(edid, (cta) => ({ ...cta, basicAudio: false, dataBlocks: cta.dataBlocks.filter((b) => !isAudio(b)) }));
}

// ---------------------------------------------------------------------------
// Mode list

export interface ModeRequest {
  readonly width: number;
  readonly height: number;
  readonly refresh: string;
  readonly formula: Formula;
  readonly rb3?: Rb3Options;
  /** Where to store it. "auto": a VIC when it is one and a CTA block exists, else a DTD, else DisplayID. */
  readonly encoding?: "auto" | "vic" | "dtd" | "displayid";
}

/** Adds a mode in the best available encoding (SPEC.md section 9), never as the preferred timing. */
export function addMode(edid: Edid, req: ModeRequest): Edid {
  const r = buildTiming({ hActive: req.width, vActive: req.height, refresh: req.refresh, formula: req.formula, ...(req.rb3 ? { rb3: req.rb3 } : {}) });
  const label = `${req.width}x${req.height} @ ${req.refresh} Hz`;
  const want = req.encoding ?? "auto";
  const vic = r.encodings.vics[0];
  const hasCta = edid.extensions.some((e) => e.kind === "cta");
  if (want === "vic" || (want === "auto" && vic !== undefined && hasCta)) {
    if (vic === undefined) throw new EdidEncodeError("mode", `${label} is no VIC's timing, so it cannot be stored as one`);
    if (!hasCta) throw new EdidEncodeError("mode", "a VIC needs a CTA-861 extension");
    return addSvd(edid, vic);
  }
  if (want === "dtd" || (want === "auto" && r.dtd)) {
    if (!r.dtd) throw new EdidEncodeError("mode", `${label} does not fit a DTD: ${r.dtdProblems.join("; ")}`);
    return addDetailedTiming(edid, r.dtd);
  }
  if (!r.displayId) throw new EdidEncodeError("mode", `${label} fits neither a DTD nor DisplayID: ${r.displayIdProblems.join("; ")}`);
  return addDisplayIdTiming(edid, r.displayId, { preferred: false });
}

/** Appends an SVD to the last video data block of the first CTA block, or adds one; 4:2:0 map indices stay valid. */
function addSvd(edid: Edid, vic: number): Edid {
  let first = true;
  return mapCta(edid, (cta) => {
    if (!first) return cta;
    first = false;
    if (cta.dataBlocks.some((b) => b.kind === "video" && b.svds.some((s) => s.vic === vic))) return cta;
    const last = cta.dataBlocks.map((b) => b.kind).lastIndexOf("video");
    if (last === -1) {
      // After an EEODB, which must stay first.
      const at = cta.dataBlocks[0]?.kind === "raw" && cta.dataBlocks[0].bytes[1] === 0x78 ? 1 : 0;
      const blocks = [...cta.dataBlocks];
      blocks.splice(at, 0, { kind: "video", svds: [{ vic, native: false }] });
      return { ...cta, dataBlocks: blocks };
    }
    return { ...cta, dataBlocks: cta.dataBlocks.map((b, i) => (i === last && b.kind === "video" ? { ...b, svds: [...b.svds, { vic, native: false }] } : b)) };
  });
}

export interface ModeMatch {
  readonly width: number;
  readonly height: number;
  /** Matched within 0.5 Hz, so 59.94 and 60 count as different modes but rounding does not. */
  readonly refreshHz: number;
}

/**
 * Removes every encoding of a mode: DTDs (a base slot becomes a dummy),
 * SVDs and 4:2:0-only SVDs, standard and established timings, and DisplayID
 * Type I timings (a section left without timings goes, and the EEODB count
 * follows). Refuses when nothing matches.
 */
export function removeMode(edid: Edid, m: ModeMatch): Edid {
  const hit = (w: number, h: number, hz: number) => w === m.width && h === m.height && Math.abs(hz - m.refreshHz) < 0.5;
  let removed = 0;
  const keepDtd = (d: Descriptor) => {
    if (d.kind !== "dtd") return true;
    const i = describeDtd(d);
    if (!hit(i.hActive, i.vActive, i.refreshHz)) return true;
    removed++;
    return false;
  };

  const base = edid.base;
  const descriptors = base.descriptors.map((d): Descriptor => (keepDtd(d) ? d : { kind: "dummy" }));
  const standardTimings = base.standardTimings.map((c) => {
    const t = decodeStandardTiming(c);
    if (t && hit(t.hActive, t.vActive, t.refreshHz)) {
      removed++;
      return UNUSED_STANDARD_TIMING;
    }
    return c;
  });
  const est: [number, number, number] = [...base.establishedTimings];
  for (const t of ESTABLISHED_TIMINGS) {
    const size = /^(\d+)x(\d+)/.exec(t.label);
    if (size && isEstablishedSet(base.establishedTimings, t) && hit(Number(size[1]), Number(size[2]), t.refreshHz)) {
      est[t.byte - 0x23] = (est[t.byte - 0x23] ?? 0) & ~(1 << t.bit);
      removed++;
    }
  }
  let out: Edid = { ...edid, base: { ...base, descriptors, standardTimings, establishedTimings: est } };

  const vicHit = (vic: number) => {
    const v = lookupVic(vic);
    return v !== undefined && hit(v.hActive, v.vActive, v.refreshHz);
  };
  out = removeSvds(out, vicHit, () => removed++);

  const extensions: Extension[] = [];
  for (const e of out.extensions) {
    if (e.kind === "cta") {
      extensions.push({ ...e, descriptors: e.descriptors.filter(keepDtd) });
      continue;
    }
    if (e.kind !== "displayid") {
      extensions.push(e);
      continue;
    }
    const dataBlocks = e.dataBlocks.flatMap((b): DisplayIdDataBlock[] => {
      if (b.kind !== "type1Timings") return [b];
      const timings = b.timings.filter((t) => {
        const i = describeDisplayIdTiming(t);
        if (!hit(i.hActive, i.vActive, i.refreshHz)) return true;
        removed++;
        return false;
      });
      return timings.length > 0 ? [{ ...b, timings }] : [];
    });
    // A section of our own making with nothing left goes; one with other data blocks stays.
    if (dataBlocks.length > 0) extensions.push({ ...e, dataBlocks });
  }
  if (removed === 0) throw new EdidEncodeError("mode", `no ${m.width}x${m.height} @ ${m.refreshHz} Hz mode to remove`);
  out = { ...out, extensions };
  return dropUnneededEeodb(withEeodb(out));
}

/** After removing blocks, an EEODB declaring a single extension is not needed. */
function dropUnneededEeodb(edid: Edid): Edid {
  if (edid.extensions.length !== 1) return edid;
  return mapCta(edid, (cta) => ({ ...cta, dataBlocks: cta.dataBlocks.filter((b) => !(b.kind === "raw" && (b.bytes[0] ?? 0) >> 5 === 7 && b.bytes[1] === 0x78)) }));
}

function removeSvds(edid: Edid, match: (vic: number) => boolean, onRemove: () => void): Edid {
  let out = edid;
  for (let e = out.extensions.length - 1; e >= 0; e--) {
    const ext = out.extensions[e];
    if (ext?.kind !== "cta") continue;
    for (let b = ext.dataBlocks.length - 1; b >= 0; b--) {
      const block = ext.dataBlocks[b];
      if (block?.kind === "video") {
        for (let s = block.svds.length - 1; s >= 0; s--) {
          const svd = block.svds[s];
          if (svd && match(svd.vic)) {
            out = removeSvd(out, e, b, s);
            onRemove();
          }
        }
      }
    }
  }
  // 4:2:0-only SVDs are not in the capability map, so they filter directly.
  return mapCta(out, (cta) => ({
    ...cta,
    dataBlocks: cta.dataBlocks.flatMap((b): DataBlock[] => {
      if (b.kind !== "ycbcr420Video") return [b];
      const svds = b.svds.filter((s) => {
        if (!match(s.vic)) return true;
        onRemove();
        return false;
      });
      return svds.length > 0 ? [{ ...b, svds }] : [];
    }),
  }));
}
