// Link budget (SPEC.md section 7): does a mode fit the link at a colour
// format and depth? The link carries blanking, so load is the pixel clock
// (total pixels per second) times bits per pixel, not visible pixels.

export type Link = "dvi" | "hdmi1.4" | "hdmi2.0";
export type ColourFormat = "rgb" | "ycbcr444" | "ycbcr422" | "ycbcr420";
export type Depth = 8 | 10 | 12 | 16;

export const LINKS: Record<Link, { readonly name: string; readonly limitKHz: number; readonly limitLabel: string }> = {
  dvi: { name: "DVI single link", limitKHz: 165_000, limitLabel: "165 MHz pixel clock" },
  "hdmi1.4": { name: "HDMI 1.4", limitKHz: 340_000, limitLabel: "340 MHz TMDS" },
  "hdmi2.0": { name: "HDMI 2.0", limitKHz: 600_000, limitLabel: "600 MHz TMDS" },
};

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
}

/** One row per format and depth: the rate the link must carry and whether it fits. */
export function feasibility(pixelClockKHz: number, link: Link): Feasibility[] {
  const limit = LINKS[link].limitKHz;
  return FORMATS.flatMap((format) =>
    DEPTHS.map((depth): Feasibility => {
      if (link === "dvi" && (format !== "rgb" || depth !== 8)) {
        return { format, depth, rateKHz: pixelClockKHz, fits: false, unsupported: "DVI carries 8-bit RGB only" };
      }
      if (format === "ycbcr420" && link !== "hdmi2.0") {
        return { format, depth, rateKHz: tmdsRateKHz(pixelClockKHz, format, depth), fits: false, unsupported: "4:2:0 needs HDMI 2.0" };
      }
      if (format === "ycbcr422" && depth === 16) {
        return { format, depth, rateKHz: pixelClockKHz, fits: false, unsupported: "4:2:2 tops out at 12-bit" };
      }
      const rateKHz = link === "dvi" ? pixelClockKHz : tmdsRateKHz(pixelClockKHz, format, depth);
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
  /** Advertised RGB depths the link cannot carry at this mode. */
  readonly tooFast: readonly Feasibility[];
  /** Advertised formats that carry the lowest failing RGB depth within the link. */
  readonly alternatives: readonly Feasibility[];
  /** Plain-language explanation, empty when everything advertised fits. */
  readonly message: string;
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
  modes: readonly { readonly mode: string; readonly pixelClockKHz: number; readonly supports420: boolean }[],
  advertised: AdvertisedColour,
  link: Link,
): ModeReport[] {
  const limit = LINKS[link];
  return modes.map(({ mode, pixelClockKHz, supports420 }) => {
    const rows = feasibility(pixelClockKHz, link);
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
      const needs = tooFast.map((r) => `${r.depth}-bit RGB needs ${(r.rateKHz / 1000).toFixed(2)} MHz`).join(", ");
      message =
        `${mode} at ${(pixelClockKHz / 1000).toFixed(2)} MHz: ${needs} TMDS, above ${limit.name}'s ${limit.limitLabel}. ` +
        (alternatives.length > 0
          ? `${first.depth}-bit fits as ${alternatives.map((a) => `${FORMAT_NAMES[a.format]} (${(a.rateKHz / 1000).toFixed(2)} MHz)`).join(" or ")}.`
          : `No advertised format carries ${first.depth}-bit at this mode; expect the driver to fall back to 8-bit.`);
    }
    return { mode, pixelClockKHz, tooFast, alternatives, message };
  });
}
