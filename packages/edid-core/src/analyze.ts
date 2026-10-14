// Collects what an EDID advertises (modes, formats, depths) for the link
// report. A first step towards the tier 3 rules of milestone M1.

import { describeDtd, lookupVic, modeLabel } from "./describe.ts";
import { linkReport } from "./link.ts";
import type { AdvertisedColour, ColourFormat, Depth, Link, ModeReport } from "./link.ts";
import type { Edid } from "./model.ts";

export function advertisedColour(edid: Edid): AdvertisedColour {
  const formats: ColourFormat[] = ["rgb"];
  const depths: Depth[] = [8];
  const depths420: Depth[] = [];
  for (const e of edid.extensions) {
    if (e.kind !== "cta") continue;
    if (e.ycbcr444 && !formats.includes("ycbcr444")) formats.push("ycbcr444");
    if (e.ycbcr422 && !formats.includes("ycbcr422")) formats.push("ycbcr422");
    for (const b of e.dataBlocks) {
      if (b.kind === "hdmiVsdb" && b.capabilities) {
        if (b.capabilities.dc30bit) depths.push(10);
        if (b.capabilities.dc36bit) depths.push(12);
        if (b.capabilities.dc48bit) depths.push(16);
      }
      if (b.kind === "hdmiForumVsdb") {
        if (b.dc30bit420) depths420.push(10);
        if (b.dc36bit420) depths420.push(12);
        if (b.dc48bit420) depths420.push(16);
      }
      if ((b.kind === "ycbcr420CapabilityMap" || b.kind === "ycbcr420Video") && !formats.includes("ycbcr420")) formats.push("ycbcr420");
    }
  }
  if (formats.includes("ycbcr420")) depths420.unshift(8);
  return { formats, depths: [...new Set(depths)], depths420: [...new Set(depths420)] };
}

/** Link report for every detailed timing and listed VIC. */
export function analyzeLink(edid: Edid, link: Link): ModeReport[] {
  const modes: { mode: string; pixelClockKHz: number; supports420: boolean }[] = [];
  const dtds = [...edid.base.descriptors, ...edid.extensions.flatMap((e) => (e.kind === "cta" ? e.descriptors : []))];
  for (const d of dtds) {
    if (d.kind !== "dtd") continue;
    const info = describeDtd(d);
    modes.push({ mode: `Timing ${modeLabel(info)}`, pixelClockKHz: info.pixelClockKHz, supports420: false });
  }

  // 4:2:0 support per SVD: capability map bits index SVDs across all video blocks.
  let index = 0;
  let map: readonly number[] | "all" | undefined;
  const only420 = new Set<number>();
  for (const e of edid.extensions) {
    if (e.kind !== "cta") continue;
    for (const b of e.dataBlocks) {
      if (b.kind === "ycbcr420CapabilityMap") map = b.bitmap.length === 0 ? "all" : b.bitmap;
      if (b.kind === "ycbcr420Video") for (const s of b.svds) only420.add(s.vic);
    }
  }
  for (const e of edid.extensions) {
    if (e.kind !== "cta") continue;
    for (const b of e.dataBlocks) {
      if (b.kind !== "video") continue;
      for (const s of b.svds) {
        const v = lookupVic(s.vic);
        const bit = map === "all" || (map !== undefined && (((map[index >> 3] ?? 0) >> (index & 7)) & 1) === 1);
        if (v) modes.push({ mode: `VIC ${s.vic} (${modeLabel(v)})`, pixelClockKHz: v.pixelClockKHz, supports420: bit });
        index++;
      }
    }
  }
  for (const vic of only420) {
    const v = lookupVic(vic);
    if (v) modes.push({ mode: `VIC ${vic} (${modeLabel(v)}, 4:2:0 only)`, pixelClockKHz: v.pixelClockKHz, supports420: true });
  }
  return linkReport(modes, advertisedColour(edid), link);
}
