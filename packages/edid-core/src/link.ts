// Link budget (SPEC.md section 7): does a mode fit the link at a colour
// format and depth? The link carries blanking, so load is the pixel clock
// (total pixels per second) times bits per pixel, not visible pixels.

export type Link = "dvi" | "hdmi1.4" | "hdmi2.0" | "hdmi2.1" | "dp1.2" | "dp1.4" | "dp2.1-uhbr10" | "dp2.1-uhbr13.5" | "dp2.1-uhbr20";
export type ColourFormat = "rgb" | "ycbcr444" | "ycbcr422" | "ycbcr420";
export type Depth = 8 | 10 | 12 | 16;

export interface LinkInfo {
  readonly name: string;
  /** "tmds": DVI and HDMI, limited by character rate. "dp": DisplayPort, limited by payload bit rate. */
  readonly kind: "tmds" | "dp";
  /** TMDS limit (DVI: pixel clock). Unused for DisplayPort. */
  readonly limitKHz: number;
  readonly limitLabel: string;
  /** DisplayPort: payload over four lanes after line coding, kbit/s. */
  readonly payloadKbps?: number;
}

/**
 * DisplayPort data rate, four lanes: 8b/10b for HBR2 and HBR3; for UHBR
 * 128b/132b, then 383/384 and 16384/16385 (the guide's calculator; see the
 * note above FRL_RATES).
 */
const dp = (name: string, gbpsPerLane: number, coding: number): LinkInfo => {
  const payloadKbps = 4 * gbpsPerLane * 1_000_000 * coding;
  return { name, kind: "dp", limitKHz: 0, limitLabel: `${(payloadKbps / 1_000_000).toFixed(2)} Gbps`, payloadKbps };
};

const UHBR_CODING = (128 / 132) * (383 / 384) * (16384 / 16385);

export const LINKS: Record<Link, LinkInfo> = {
  dvi: { name: "DVI single link", kind: "tmds", limitKHz: 165_000, limitLabel: "165 MHz pixel clock" },
  "hdmi1.4": { name: "HDMI 1.4", kind: "tmds", limitKHz: 340_000, limitLabel: "340 MHz TMDS" },
  "hdmi2.0": { name: "HDMI 2.0", kind: "tmds", limitKHz: 600_000, limitLabel: "600 MHz TMDS" },
  "hdmi2.1": { name: "HDMI 2.1", kind: "tmds", limitKHz: 600_000, limitLabel: "600 MHz TMDS or 48 Gbps FRL" },
  "dp1.2": dp("DisplayPort 1.2 (HBR2)", 5.4, 8 / 10),
  "dp1.4": dp("DisplayPort 1.4 (HBR3)", 8.1, 8 / 10),
  "dp2.1-uhbr10": dp("DisplayPort 2.1 (UHBR10)", 10, UHBR_CODING),
  "dp2.1-uhbr13.5": dp("DisplayPort 2.1 (UHBR13.5)", 13.5, UHBR_CODING),
  "dp2.1-uhbr20": dp("DisplayPort 2.1 (UHBR20)", 20, UHBR_CODING),
};

/** Bits per pixel on DisplayPort: no container, so 4:2:2 is two components and 4:2:0 one and a half. */
export function dpBitsPerPixel(format: ColourFormat, depth: Depth): number {
  switch (format) {
    case "rgb":
    case "ycbcr444":
      return 3 * depth;
    case "ycbcr422":
      return 2 * depth;
    case "ycbcr420":
      return 1.5 * depth;
  }
}

/** One HDMI 2.1 Fixed Rate Link rate, as coded in the HDMI Forum VSDB (edid-decode max_frl_rates). */
// Link capacity model: the HDMI 2.1 and DisplayPort 2.x specifications are
// not available to us (paid, under NDA). FRL and UHBR overheads and the FRL
// data-rate formula follow the calculator in Glenwing's "Guide to Display
// Cables / Adapters v2" (linustechtips.com/topic/729232, as archived on
// 2026-10-05), which the owner has found accurate. Known answers from its
// tables are in test/link-kat.test.ts. TODO(verify) against hardware.

export interface FrlRate {
  readonly code: number;
  readonly lanes: 3 | 4;
  readonly gbpsPerLane: number;
  /** Data rate after all FRL overhead, in kbit/s. */
  readonly payloadKbps: number;
  /** Data rate / raw rate: 16b/18b, RS FEC 251/255, 2040/2044 (2040/2043 on 3 lanes), 2007/2008. */
  readonly overhead: number;
}

export const FRL_RATES: readonly FrlRate[] = (
  [
    [1, 3, 3],
    [2, 3, 6],
    [3, 4, 6],
    [4, 4, 8],
    [5, 4, 10],
    [6, 4, 12],
  ] as const
).map(([code, lanes, gbpsPerLane]) => {
  const overhead = (16 / 18) * (251 / 255) * (lanes === 3 ? 2040 / 2043 : 2040 / 2044) * (2007 / 2008);
  return { code, lanes, gbpsPerLane, overhead, payloadKbps: lanes * gbpsPerLane * 1_000_000 * overhead };
});

/** The shape of a timing, which FRL needs beyond the pixel clock: its blanking is partly compressed. */
export interface TimingGeometry {
  readonly hActive: number;
  readonly hTotal: number;
  readonly vTotal: number;
}

/** A stream on an FRL link: the pixel clock, plus its geometry when known. */
export interface FrlStream extends Partial<TimingGeometry> {
  readonly pixelClockKHz: number;
}

/**
 * Data rate an uncompressed stream needs on an FRL rate, kbit/s. With the
 * geometry: P x (24K - 18 x RC x overhead / H), where K is bits per pixel /
 * 24 (1 for 4:2:2's 12-bit container), H the active width, and RC the
 * blanking characters FRL drops after room for audio packets (APL per line
 * from a 51 kHz packet rate). Without it: P x 24K, a little high.
 */
export function frlNeedKbps(stream: FrlStream, rate: FrlRate, format: ColourFormat, depth: Depth): number {
  const p = stream.pixelClockKHz; // kHz, so the result is kbit/s
  const k = frlBitsPerPixel(format, depth) / 24;
  if (stream.hActive === undefined || stream.hTotal === undefined || stream.vTotal === undefined) return p * 24 * k;
  const hBlank = stream.hTotal - stream.hActive;
  const lineRateHz = (p * 1000) / stream.hTotal;
  const apl = Math.ceil(51_000 / lineRateHz);
  const rc = Math.floor(Math.min(Math.max(0, (Math.max(0, hBlank * k - apl * 32 - 7) * 7) / 8 - 4), 400));
  return p * (24 * k - (18 * rc * rate.overhead) / stream.hActive);
}

/** The lowest FRL rate that carries the stream, if any does. */
export function frlRateFor(stream: FrlStream, format: ColourFormat = "rgb", depth: Depth = 8): FrlRate | undefined {
  return FRL_RATES.find((r) => frlNeedKbps(stream, r, format, depth) <= r.payloadKbps);
}

/** Bits per pixel on an FRL link; 4:2:2 keeps its 12-bit, two-component container. */
export function frlBitsPerPixel(format: ColourFormat, depth: Depth): number {
  switch (format) {
    case "rgb":
    case "ycbcr444":
      return 3 * depth;
    case "ycbcr422":
      return 24;
    case "ycbcr420":
      return 1.5 * depth;
  }
}

export const FORMAT_NAMES: Record<ColourFormat, string> = {
  rgb: "RGB",
  ycbcr444: "YCbCr 4:4:4",
  ycbcr422: "YCbCr 4:2:2",
  ycbcr420: "YCbCr 4:2:0",
};

export const DEPTHS: readonly Depth[] = [8, 10, 12, 16];
export const FORMATS: readonly ColourFormat[] = ["rgb", "ycbcr444", "ycbcr422", "ycbcr420"];

/**
 * TMDS character rate in kHz (HDMI 2.0; SPEC.md section 7 table):
 * RGB and 4:4:4 scale by depth / 8; 4:2:2 always uses a 12-bit container at
 * the pixel clock; 4:2:0 halves the clock, then scales by depth / 8.
 */
export function tmdsRateKHz(pixelClockKHz: number, format: ColourFormat, depth: Depth): number {
  switch (format) {
    case "rgb":
    case "ycbcr444":
      return (pixelClockKHz * depth) / 8;
    case "ycbcr422":
      return pixelClockKHz;
    case "ycbcr420":
      return ((pixelClockKHz / 2) * depth) / 8;
  }
}

export interface Feasibility {
  readonly format: ColourFormat;
  readonly depth: Depth;
  readonly rateKHz: number;
  readonly fits: boolean;
  /** Why it does not apply on this link, if it does not (e.g. DVI has no YCbCr). */
  readonly unsupported?: string;
  /** HDMI 2.1: the FRL rate it needs when TMDS cannot carry it. */
  readonly frl?: FrlRate;
  /** Video bit rate in kbit/s: DisplayPort always, HDMI 2.1 when it goes over FRL. */
  readonly kbps?: number;
}

/** One row per format and depth: the rate the link must carry and whether it fits. */
export function feasibility(pixelClockKHz: number, link: Link, geometry?: TimingGeometry): Feasibility[] {
  const limit = LINKS[link].limitKHz;
  const payload = LINKS[link].payloadKbps;
  return FORMATS.flatMap((format) =>
    DEPTHS.map((depth): Feasibility => {
      if (payload !== undefined) {
        // DisplayPort carries the stream at pixel clock x bits per pixel against the lane payload.
        const kbps = pixelClockKHz * dpBitsPerPixel(format, depth);
        if (format === "ycbcr420" && link === "dp1.2") return { format, depth, rateKHz: pixelClockKHz, kbps, fits: false, unsupported: "4:2:0 needs DisplayPort 1.3 or later" };
        return { format, depth, rateKHz: pixelClockKHz, kbps, fits: kbps <= payload };
      }
      if (link === "dvi" && (format !== "rgb" || depth !== 8)) {
        return { format, depth, rateKHz: pixelClockKHz, fits: false, unsupported: "DVI carries 8-bit RGB only" };
      }
      if (format === "ycbcr420" && link !== "hdmi2.0" && link !== "hdmi2.1") {
        return { format, depth, rateKHz: tmdsRateKHz(pixelClockKHz, format, depth), fits: false, unsupported: "4:2:0 needs HDMI 2.0" };
      }
      if (format === "ycbcr422" && depth === 16) {
        return { format, depth, rateKHz: pixelClockKHz, fits: false, unsupported: "4:2:2 tops out at 12-bit" };
      }
      const rateKHz = link === "dvi" ? pixelClockKHz : tmdsRateKHz(pixelClockKHz, format, depth);
      if (link === "hdmi2.1" && rateKHz > limit) {
        // Above 600 MHz TMDS, HDMI 2.1 switches to FRL.
        const stream: FrlStream = { pixelClockKHz, ...geometry };
        const frl = frlRateFor(stream, format, depth);
        const top = FRL_RATES[FRL_RATES.length - 1];
        const kbps = frl ? frlNeedKbps(stream, frl, format, depth) : top ? frlNeedKbps(stream, top, format, depth) : 0;
        return { format, depth, rateKHz, fits: frl !== undefined, kbps, ...(frl ? { frl } : {}) };
      }
      return { format, depth, rateKHz, fits: rateKHz <= limit };
    }),
  );
}

/**
 * Likely driver choice, a labelled heuristic and not a spec: prefer RGB,
 * then 4:4:4, 4:2:2, 4:2:0, at the highest depth that is both advertised and
 * fits the link (SPEC.md section 7).
 */
export function likelyChoice(rows: readonly Feasibility[], advertised: (f: ColourFormat, d: Depth) => boolean): Feasibility | undefined {
  for (const format of FORMATS) {
    const fitting = rows.filter((r) => r.format === format && r.fits && advertised(r.format, r.depth)).sort((a, b) => b.depth - a.depth);
    if (fitting[0]) return fitting[0];
  }
  return undefined;
}

export interface ModeReport {
  /** "Timing 3840x2160 @ 60.000 Hz" or "VIC 97 (3840x2160 @ 60.000 Hz)". */
  readonly mode: string;
  readonly pixelClockKHz: number;
  /** The timing's shape, when known (detailed and DisplayID timings); FRL uses it. */
  readonly geometry?: TimingGeometry;
  /** Advertised RGB depths the link cannot carry at this mode. */
  readonly tooFast: readonly Feasibility[];
  /** Advertised formats that carry the lowest failing RGB depth within the link. */
  readonly alternatives: readonly Feasibility[];
  /** Plain-language explanation, empty when everything advertised fits. */
  readonly message: string;
  /** Every format and depth the EDID advertises for this mode, whether or not it fits. */
  readonly advertised: readonly Feasibility[];
  /** Likely driver choice (heuristic, see likelyChoice()); absent when nothing advertised fits. */
  readonly likely?: Feasibility;
}

export interface AdvertisedColour {
  readonly formats: readonly ColourFormat[];
  /** Depths advertised for RGB (8 plus HDMI VSDB deep colour flags). */
  readonly depths: readonly Depth[];
  /** Depths advertised for 4:2:0 (HDMI Forum VSDB), always including 8 when 4:2:0 is offered. */
  readonly depths420: readonly Depth[];
}

/**
 * For each mode, which advertised RGB depths exceed the link, and which
 * advertised formats would carry the same depth (SPEC.md section 7). The
 * caller supplies the modes and what the EDID advertises.
 */
export function linkReport(
  modes: readonly { readonly mode: string; readonly pixelClockKHz: number; readonly supports420: boolean; readonly geometry?: TimingGeometry }[],
  advertised: AdvertisedColour,
  link: Link,
): ModeReport[] {
  const limit = LINKS[link];
  return modes.map(({ mode, pixelClockKHz, supports420, geometry }) => {
    const rows = feasibility(pixelClockKHz, link, geometry);
    // What the EDID offers at this mode: RGB and 4:4:4 at the deep colour depths, 4:2:2 at any depth
    // up to 12-bit (a 12-bit container; SPEC.md section 7), 4:2:0 only where the mode allows it.
    const offers = (f: ColourFormat, d: Depth) => {
      if (f === "rgb") return advertised.depths.includes(d);
      if (!advertised.formats.includes(f)) return false;
      if (f === "ycbcr444") return advertised.depths.includes(d);
      if (f === "ycbcr422") return d <= 12;
      return supports420 && advertised.depths420.includes(d);
    };
    const offered = rows.filter((r) => !r.unsupported && offers(r.format, r.depth));
    const likely = likelyChoice(rows, offers);
    const tooFast = rows.filter((r) => r.format === "rgb" && advertised.depths.includes(r.depth) && !r.fits);
    // The lowest failing depth is the one a user most likely wants (10-bit over 8-bit).
    const first = tooFast.reduce<Feasibility | undefined>((a, r) => (a && a.depth < r.depth ? a : r), undefined);
    const alternatives = first
      ? rows.filter((r) => {
          if (!r.fits || r.depth !== first.depth || r.format === "rgb") return false;
          if (r.format === "ycbcr420") return supports420 && advertised.formats.includes("ycbcr420") && advertised.depths420.includes(r.depth);
          if (r.format === "ycbcr422") return advertised.formats.includes("ycbcr422");
          return advertised.formats.includes(r.format) && advertised.depths.includes(r.depth);
        })
      : [];
    let message = "";
    if (first) {
      // Over FRL the load is a bit rate; over TMDS it is the character rate.
      const frl = tooFast.some((r) => r.kbps !== undefined);
      const need = (r: Feasibility) => (r.kbps !== undefined ? `${(r.kbps / 1_000_000).toFixed(2)} Gbps` : `${(r.rateKHz / 1000).toFixed(2)} MHz`);
      const needs = tooFast.map((r) => `${r.depth}-bit RGB needs ${need(r)}`).join(", ");
      const via = (a: Feasibility) =>
        a.frl ? `FRL ${a.frl.gbpsPerLane} Gbps x ${a.frl.lanes}` : a.kbps !== undefined ? `${(a.kbps / 1_000_000).toFixed(2)} Gbps` : `${(a.rateKHz / 1000).toFixed(2)} MHz`;
      message =
        `${mode} at ${(pixelClockKHz / 1000).toFixed(2)} MHz: ${needs}${frl ? "" : " TMDS"}, above ${limit.name}'s ${limit.limitLabel}. ` +
        (alternatives.length > 0
          ? `${first.depth}-bit fits as ${alternatives.map((a) => `${FORMAT_NAMES[a.format]} (${via(a)})`).join(" or ")}.`
          : `No advertised format carries ${first.depth}-bit at this mode; expect the driver to fall back to 8-bit.`);
    }
    return { mode, pixelClockKHz, ...(geometry ? { geometry } : {}), tooFast, alternatives, message, advertised: offered, ...(likely ? { likely } : {}) };
  });
}
