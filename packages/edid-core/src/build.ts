// Builds an EDID from intent, without a base file (SPEC.md section 3,
// workflow 2). The result is EDID 1.3, which the HDMI specification requires
// (edid-decode fails HDMI sinks on 1.4), with one CTA-861 extension for HDMI.

import { encodeManufacturerId } from "./base-block.ts";
import { EdidEncodeError } from "./errors.ts";
import { tmdsRateKHz } from "./link.ts";
import type { ColourFormat, Depth, Link } from "./link.ts";
import type { CtaExtension, DataBlock, Descriptor, DetailedTimingDescriptor, Edid } from "./model.ts";
import { autoRangeLimits, setColor, setMonitorName, setRangeLimits } from "./ops.ts";

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
  readonly link: Link;
  readonly formats: readonly ColourFormat[];
  readonly depths: readonly Depth[];
}

/**
 * Builds a complete EDID 1.3:
 * - digital input, sRGB primaries and flag, no image size (never invented);
 * - 640x480 @ 60 Hz as an established timing (CTA-861 requires it; it is far
 *   too small for a driver to prefer), and no standard timings;
 * - descriptors: preferred timing, range limits (auto; default GTF, since
 *   "range limits only" is EDID 1.4), monitor name, and a dummy or a second
 *   timing;
 * - for HDMI: a CTA-861 extension with an HDMI VSDB (deep colour, max TMDS),
 *   an HDMI Forum VSDB with SCDC when any mode needs more than 340 MHz, and a
 *   video capability block. No VICs are listed: the Tessera case showed a
 *   driver can choose a standard VIC the link cannot carry at the chosen depth.
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
      // 640x480 @ 60 Hz: block 0 byte 0x23 bit 5.
      establishedTimings: [0x20, 0, 0],
      standardTimings: new Array(8).fill([0x01, 0x01]),
      descriptors: baseDescriptors,
    },
    extensions: [],
  };

  if (hdmi) {
    const worst = Math.max(...timings.map((t) => Math.max(...intent.depths.map((d) => tmdsRateKHz(t.pixelClock10kHz * 10, "rgb", d)))));
    const dataBlocks: DataBlock[] = [
      {
        kind: "hdmiVsdb",
        physicalAddress: 0x1000,
        capabilities: { supportsAi: false, dc48bit: false, dc36bit: false, dc30bit: false, dcY444: false, reserved: 0, dviDual: false },
        // The HDMI 1.4 VSDB field tops out at 340 MHz; above that the HDMI Forum VSDB states the rate.
        maxTmdsClock5MHz: Math.min(68, Math.ceil(worst / 5000)),
        tail: [],
      },
    ];
    if (worst > 340_000) {
      if (intent.link !== "hdmi2.0") throw new EdidEncodeError("link", `this mode needs ${(worst / 1000).toFixed(2)} MHz TMDS, above HDMI 1.4's 340 MHz`);
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
        maxFrlRate: 0,
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
    edid = { ...edid, extensions: [cta] };
  } else if (rest.length > 0) {
    throw new EdidEncodeError("timings", "DVI EDIDs here hold at most two timings");
  }

  edid = setColor(edid, intent.formats, intent.depths);
  const limits = autoRangeLimits(edid, "default");
  if (limits) edid = setRangeLimits(edid, limits);
  return setMonitorName(edid, intent.name);
}
