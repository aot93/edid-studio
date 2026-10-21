// Builds an EDID from intent, without a base file (SPEC.md section 3,
// workflow 2). The result is EDID 1.3, which the HDMI specification requires
// (edid-decode fails HDMI sinks on 1.4), with one CTA-861 extension for HDMI
// and a DisplayID extension for timings a DTD cannot hold.

import { encodeManufacturerId } from "./base-block.ts";
import { EXT_HF_EEODB } from "./cta.ts";
import { displayIdSection } from "./displayid.ts";
import { EdidEncodeError } from "./errors.ts";
import { dpBitsPerPixel, frlBitsPerPixel, frlRateFor, LINKS, tmdsRateKHz } from "./link.ts";
import type { ColourFormat, Depth, Link } from "./link.ts";
import type { CtaExtension, DataBlock, Descriptor, DetailedTimingDescriptor, DisplayIdTiming, Edid, Extension } from "./model.ts";
import { autoRangeLimits, setColor, setMonitorName, setRangeLimits } from "./ops.ts";
import { buildTiming } from "./timing.ts";
import type { Rational } from "./timing.ts";

export interface Chromaticity {
  readonly red: readonly [number, number];
  readonly green: readonly [number, number];
  readonly blue: readonly [number, number];
  readonly white: readonly [number, number];
}

/** sRGB / BT.709 primaries and D65 white. */
export const SRGB: Chromaticity = { red: [0.64, 0.33], green: [0.3, 0.6], blue: [0.15, 0.06], white: [0.3127, 0.329] };

/** Encodes CIE xy coordinates as 10-bit fractions of 1024 (E-EDID 1.4 section 3.7). */
export function encodeChromaticity(c: Chromaticity): number[] {
  const v = [c.red[0], c.red[1], c.green[0], c.green[1], c.blue[0], c.blue[1], c.white[0], c.white[1]].map((x) => {
    if (!(x >= 0 && x < 1)) throw new EdidEncodeError("chromaticity", `chromaticity ${x} must be from 0 to below 1`);
    return Math.round(x * 1024);
  });
  const lo = (i: number) => (v[i] ?? 0) & 0x03;
  return [
    (lo(0) << 6) | (lo(1) << 4) | (lo(2) << 2) | lo(3),
    (lo(4) << 6) | (lo(5) << 4) | (lo(6) << 2) | lo(7),
    ...v.map((x) => x >> 2),
  ];
}

/**
 * A DisplayPort sink: EDID 1.4, which DisplayPort sinks use, with the bit
 * depth and the DisplayPort interface in byte 20 and the YCbCr formats in
 * byte 24 (E-EDID 1.4 tables 3.11 and 3.14); no CTA extension, so up to two
 * DTDs; range limits "range limits only", allowed from EDID 1.4. Timings a
 * DTD cannot hold go in a DisplayID block; EDID 1.4 needs no EEODB for it.
 */
function buildDisplayPortEdid(intent: BuildIntent, timings: readonly DetailedTimingDescriptor[], displayIdTimings: readonly DisplayIdTiming[], displayId: Extension[]): Edid {
  const link = LINKS[intent.link];
  const payload = link.payloadKbps ?? 0;
  const clocks = [...timings, ...displayIdTimings].map((t) => t.pixelClock10kHz * 10);
  const kbps = Math.max(...clocks.flatMap((c) => intent.formats.flatMap((f) => intent.depths.map((d) => c * dpBitsPerPixel(f, d)))));
  if (kbps > payload) throw new EdidEncodeError("link", `this mode needs ${(kbps / 1_000_000).toFixed(2)} Gbps, above ${link.name}'s ${link.limitLabel}`);
  if (timings.length > 2) throw new EdidEncodeError("timings", "DisplayPort EDIDs here hold at most two DTDs (no CTA extension)");
  const [, second] = timings;

  let edid: Edid = {
    base: {
      manufacturerCode: encodeManufacturerId(intent.manufacturerId),
      productCode: intent.productCode,
      serialNumber: intent.serialNumber ?? 0,
      week: 0,
      yearOffset: intent.year - 1990,
      version: 1,
      revision: 4,
      // Digital, DisplayPort interface (5); setColor fills in the depth.
      videoInput: 0x80 | 0x05,
      screenSize: [0, 0],
      gamma: 120,
      // Byte 24 (EDID 1.4): sRGB default colour space bit 2, preferred timing is native bit 1; setColor sets the YCbCr bits.
      features: 0x04 | 0x02,
      chromaticity: encodeChromaticity(SRGB),
      establishedTimings: [intent.include640x480 ? 0x20 : 0, 0, 0],
      standardTimings: new Array(8).fill([0x01, 0x01]),
      descriptors: [intent.timing, { kind: "dummy" }, { kind: "dummy" }, second ?? { kind: "dummy" }],
    },
    extensions: displayId,
  };
  edid = setColor(edid, intent.formats, intent.depths);
  const limits = autoRangeLimits(edid, "none");
  if (limits) edid = setRangeLimits(edid, limits);
  return setMonitorName(edid, intent.name);
}

/** Base-block timing for sources that ignore DisplayID: 1920x1080 at the requested refresh, exact where it can be. */
export function fallbackDtd(refresh: string | Rational): DetailedTimingDescriptor {
  const r = buildTiming({ hActive: 1920, vActive: 1080, refresh, formula: "exact" });
  if (!r.dtd) throw new EdidEncodeError("fallback timing", `no 1920x1080 fallback fits a DTD at this refresh: ${r.dtdProblems.join("; ")}`);
  return r.dtd;
}

export interface BuildIntent {
  readonly name: string;
  /** Three letters A-Z. */
  readonly manufacturerId: string;
  readonly productCode: number;
  readonly serialNumber?: number;
  /** Year of manufacture (week left unspecified: EDID 1.3 has no model-year code). */
  readonly year: number;
  /** The preferred timing. */
  readonly timing: DetailedTimingDescriptor;
  /** Further timings, if any (one fits in the base block, more go in the CTA block). */
  readonly extraTimings?: readonly DetailedTimingDescriptor[];
  /**
   * Timings a DTD cannot hold (wider or taller than 4095, or a clock above
   * 655.35 MHz), for a DisplayID extension block; the first is preferred.
   * `timing` stays in the base block as the fallback for sources that
   * ignore DisplayID.
   */
  readonly displayIdTimings?: readonly DisplayIdTiming[];
  readonly link: Link;
  readonly formats: readonly ColourFormat[];
  readonly depths: readonly Depth[];
  /**
   * List 640x480 @ 60 Hz as an established timing. CTA-861 requires it and
   * edid-decode fails without it, but it is one more mode a source may use,
   * so it is off unless asked for.
   */
  readonly include640x480?: boolean;
}

/**
 * Builds a complete EDID 1.3:
 * - digital input, sRGB primaries and flag, no image size (never invented);
 * - no standard timings, and no established timings unless include640x480
 *   asks for 640x480 @ 60 Hz;
 * - descriptors: preferred timing, range limits (auto; default GTF, since
 *   "range limits only" is EDID 1.4), monitor name, and a dummy or a second
 *   timing;
 * - for HDMI: a CTA-861 extension with an HDMI VSDB (deep colour, max TMDS),
 *   an HDMI Forum VSDB with SCDC when any mode needs more than 340 MHz, and a
 *   video capability block. No VICs are listed: the Tessera case showed a
 *   driver can choose a standard VIC the link cannot carry at the chosen depth.
 * - with DisplayID timings: a DisplayID extension after the CTA block. EDID
 *   1.3 allows a third block only with a block map or an HDMI Forum EEODB
 *   (edid-decode check_base_block()); this uses the EEODB, so byte 126 says 1
 *   and sources that do not read the EEODB see a sound two-block EDID with
 *   the fallback timing. TODO(verify): NVIDIA drivers read the EEODB.
 */
export function buildEdid(intent: BuildIntent): Edid {
  if (!Number.isInteger(intent.year) || intent.year < 1990 || intent.year > 2245) {
    throw new EdidEncodeError("year", `year ${intent.year} must be from 1990 to 2245`);
  }
  if (intent.link === "dvi" && (intent.formats.some((f) => f !== "rgb") || intent.depths.some((d) => d !== 8))) {
    throw new EdidEncodeError("colour", "DVI carries 8-bit RGB only");
  }
  if (intent.formats.includes("ycbcr420")) {
    throw new EdidEncodeError("colour formats", "4:2:0 can only be declared for VICs, not for a custom detailed timing");
  }
  const timings = [intent.timing, ...(intent.extraTimings ?? [])];
  const displayIdTimings = intent.displayIdTimings ?? [];
  if (intent.formats.includes("ycbcr422")) {
    // 4:2:2 shares chroma between pixel pairs (SPEC.md section 6).
    const odd = [...timings, ...displayIdTimings].find((t) => t.hActive % 2 === 1);
    if (odd) throw new EdidEncodeError("colour formats", `YCbCr 4:2:2 needs an even width; ${odd.hActive} is odd`);
  }
  const displayId: Extension[] = displayIdTimings.length > 0 ? [displayIdSection(displayIdTimings)] : [];
  if (LINKS[intent.link].kind === "dp") return buildDisplayPortEdid(intent, timings, displayIdTimings, displayId);
  const hdmi = intent.link !== "dvi";

  // Byte 24 (EDID 1.3): display type RGB colour in bits 4-3 (01), sRGB
  // default colour space bit 2, preferred timing bit 1.
  const features = 0x08 | 0x04 | 0x02;
  const baseDescriptors: Descriptor[] = [intent.timing, { kind: "dummy" }, { kind: "dummy" }, { kind: "dummy" }];
  const [, second, ...rest] = timings;
  if (second) baseDescriptors[3] = second;

  let edid: Edid = {
    base: {
      manufacturerCode: encodeManufacturerId(intent.manufacturerId),
      productCode: intent.productCode,
      serialNumber: intent.serialNumber ?? 0,
      week: 0,
      yearOffset: intent.year - 1990,
      version: 1,
      revision: 3,
      // Digital. EDID 1.3 has no bit depth or interface field; HDMI blocks carry depth.
      videoInput: 0x80,
      screenSize: [0, 0],
      gamma: 120, // 2.2: stored as gamma x 100 - 100
      features,
      chromaticity: encodeChromaticity(SRGB),
      // 640x480 @ 60 Hz is block 0 byte 0x23 bit 5.
      establishedTimings: [intent.include640x480 ? 0x20 : 0, 0, 0],
      standardTimings: new Array(8).fill([0x01, 0x01]),
      descriptors: baseDescriptors,
    },
    extensions: [],
  };

  if (hdmi) {
    const clocks = [...timings, ...displayIdTimings].map((t) => t.pixelClock10kHz * 10);
    const worst = Math.max(...clocks.map((c) => Math.max(...intent.depths.map((d) => tmdsRateKHz(c, "rgb", d)))));
    const dataBlocks: DataBlock[] = [
      // HDMI Forum EEODB, first data block of block 1: extended tag 0x78, the real extension count (edid-decode cta_hf_eeodb()).
      ...(displayId.length > 0 ? [{ kind: "raw", bytes: [(7 << 5) | 2, EXT_HF_EEODB, 1 + displayId.length] } as const] : []),
      {
        kind: "hdmiVsdb",
        physicalAddress: 0x1000,
        capabilities: { supportsAi: false, dc48bit: false, dc36bit: false, dc30bit: false, dcY444: false, reserved: 0, dviDual: false },
        // The HDMI 1.4 VSDB field tops out at 340 MHz; above that the HDMI Forum VSDB states the rate.
        maxTmdsClock5MHz: Math.min(68, Math.ceil(worst / 5000)),
        tail: [],
      },
    ];
    // Above 600 MHz TMDS, HDMI 2.1 needs FRL: the lowest rate that carries the fastest mode at the deepest depth.
    let maxFrlRate = 0;
    if (worst > 600_000) {
      if (intent.link !== "hdmi2.1") throw new EdidEncodeError("link", `this mode needs ${(worst / 1000).toFixed(2)} MHz TMDS, above ${LINKS[intent.link].name}'s ${LINKS[intent.link].limitLabel}`);
      const kbps = Math.max(...clocks.map((c) => Math.max(...intent.depths.map((d) => c * frlBitsPerPixel("rgb", d)))));
      const frl = frlRateFor(kbps);
      if (!frl) throw new EdidEncodeError("link", `this mode needs ${(kbps / 1_000_000).toFixed(2)} Gbps, above HDMI 2.1's 48 Gbps FRL`);
      maxFrlRate = frl.code;
    }
    if (worst > 340_000) {
      if (intent.link === "hdmi1.4") throw new EdidEncodeError("link", `this mode needs ${(worst / 1000).toFixed(2)} MHz TMDS, above HDMI 1.4's 340 MHz`);
      dataBlocks.push({
        kind: "hdmiForumVsdb",
        version: 1,
        maxTmdsCharRate5MHz: 120,
        scdcPresent: true,
        scdcReadRequest: false,
        cableStatus: false,
        ccbpci: false,
        lte340McscScramble: false,
        independentView3d: false,
        dualView3d: false,
        osdDisparity3d: false,
        maxFrlRate,
        uhdVic: false,
        dc48bit420: false,
        dc36bit420: false,
        dc30bit420: false,
        tail: [],
      });
    }
    // Selectable quantisation; IT and CE always underscanned (2); S_PT 0 defers to them.
    dataBlocks.push({ kind: "videoCapability", qy: true, qs: true, ptBehaviour: 0, itBehaviour: 2, ceBehaviour: 2, extra: [] });
    const cta: CtaExtension = {
      kind: "cta",
      revision: 3,
      underscan: true,
      basicAudio: false,
      ycbcr444: false,
      ycbcr422: false,
      nativeDtdCount: 1,
      dataBlocks,
      descriptors: rest,
    };
    edid = { ...edid, extensions: [cta, ...displayId] };
  } else if (rest.length > 0) {
    throw new EdidEncodeError("timings", "DVI EDIDs here hold at most two timings");
  } else {
    edid = { ...edid, extensions: displayId };
  }

  edid = setColor(edid, intent.formats, intent.depths);
  const limits = autoRangeLimits(edid, "default");
  if (limits) edid = setRangeLimits(edid, limits);
  return setMonitorName(edid, intent.name);
}
