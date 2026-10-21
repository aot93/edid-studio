// Plain-language differences between two models (SPEC.md section 9: every
// operation reports what it changed). Used by `edidtool diff` and by the
// recipe runner after each step. EDID text is quoted through printable().

import { advertisedColour } from "./analyze.ts";
import { manufacturerId } from "./base-block.ts";
import { decodeStandardTiming, ESTABLISHED_TIMINGS, isEstablishedSet } from "./base-timings.ts";
import { describeDtd, lookupVic, modeLabel } from "./describe.ts";
import { describeDisplayIdTiming, displayIdTimings, preferredDisplayIdTiming } from "./displayid.ts";
import type { CtaExtension, DataBlock, Edid, HdmiForumVsdb, HdmiVsdb } from "./model.ts";
import { printable } from "./safety.ts";

const yesNo = (v: boolean) => (v ? "yes" : "no");

function change(out: string[], label: string, a: string, b: string): void {
  if (a !== b) out.push(`${label}: ${a} → ${b}`);
}

/** Every mode with its encoding, as a stable label. */
export function modeLabels(edid: Edid): string[] {
  const out: string[] = [];
  const dtds = [...edid.base.descriptors, ...edid.extensions.flatMap((e) => (e.kind === "cta" ? e.descriptors : []))];
  for (const d of dtds) if (d.kind === "dtd") out.push(`detailed timing ${modeLabel(describeDtd(d))}`);
  for (const t of displayIdTimings(edid)) out.push(`DisplayID timing ${modeLabel(describeDisplayIdTiming(t))}`);
  for (const c of edid.base.standardTimings) {
    const t = decodeStandardTiming(c);
    if (t) out.push(`standard timing ${t.hActive}x${t.vActive} @ ${t.refreshHz} Hz`);
  }
  for (const t of ESTABLISHED_TIMINGS) if (isEstablishedSet(edid.base.establishedTimings, t)) out.push(`established timing ${t.label}`);
  for (const e of edid.extensions) {
    if (e.kind !== "cta") continue;
    for (const b of e.dataBlocks) {
      if (b.kind !== "video" && b.kind !== "ycbcr420Video") continue;
      for (const s of b.svds) {
        const v = lookupVic(s.vic);
        out.push(`VIC ${s.vic}${v ? ` (${modeLabel(v)})` : ""}${b.kind === "ycbcr420Video" ? ", 4:2:0 only" : ""}`);
      }
    }
  }
  return out;
}

function preferred(edid: Edid): string {
  const id = preferredDisplayIdTiming(edid);
  if (id) {
    const i = describeDisplayIdTiming(id);
    return `${modeLabel(i)} (${(i.pixelClockKHz / 1000).toFixed(2)} MHz, DisplayID)`;
  }
  const d = edid.base.descriptors[0];
  if (d?.kind !== "dtd") return "none";
  const i = describeDtd(d);
  return `${modeLabel(i)} (${(i.pixelClockKHz / 1000).toFixed(2)} MHz)`;
}

function text(edid: Edid, tag: number): string {
  const d = edid.base.descriptors.find((x) => x.kind === "text" && x.tag === tag);
  return d?.kind === "text" ? `"${printable(d.text, 13)}"` : "none";
}

function range(edid: Edid): string {
  const r = edid.base.descriptors.find((d) => d.kind === "rangeLimits");
  if (r?.kind !== "rangeLimits") return "none";
  return `${r.minVerticalHz}-${r.maxVerticalHz} Hz, ${r.minHorizontalKHz}-${r.maxHorizontalKHz} kHz, ${r.maxPixelClock10MHz * 10} MHz`;
}

/** Names a data block without its contents, for "added" and "removed". */
export function dataBlockName(b: DataBlock): string {
  switch (b.kind) {
    case "audio":
      return "audio data block";
    case "speakerAllocation":
      return "speaker allocation data block";
    case "video":
      return "video data block";
    case "ycbcr420Video":
      return "YCbCr 4:2:0 video data block";
    case "ycbcr420CapabilityMap":
      return "YCbCr 4:2:0 capability map";
    case "videoCapability":
      return "video capability data block";
    case "hdmiVsdb":
      return "HDMI VSDB";
    case "hdmiForumVsdb":
      return "HDMI Forum VSDB";
    case "raw": {
      const tag = (b.bytes[0] ?? 0) >> 5;
      if (tag === 7) return b.bytes[1] === 0x78 ? "HDMI Forum EEODB" : `extended data block 0x${(b.bytes[1] ?? 0).toString(16).padStart(2, "0")}`;
      return `data block with tag ${tag}`;
    }
  }
}

function firstCta(edid: Edid): CtaExtension | undefined {
  const e = edid.extensions.find((x) => x.kind === "cta");
  return e?.kind === "cta" ? e : undefined;
}

function blockOf<K extends DataBlock["kind"]>(edid: Edid, kind: K): Extract<DataBlock, { kind: K }> | undefined {
  for (const e of edid.extensions) {
    if (e.kind !== "cta") continue;
    const b = e.dataBlocks.find((x) => x.kind === kind);
    if (b) return b as Extract<DataBlock, { kind: K }>;
  }
  return undefined;
}

function pa(v: HdmiVsdb | undefined): string {
  if (!v) return "none";
  return [12, 8, 4, 0].map((s) => (v.physicalAddress >> s) & 0xf).join(".");
}

function depths(list: readonly number[]): string {
  const deep = list.filter((d) => d > 8);
  return deep.length === 0 ? "none" : `${deep.join(", ")}-bit`;
}

function forumRate(f: HdmiForumVsdb | undefined): string {
  return f ? (f.maxTmdsCharRate5MHz === 0 ? "340 MHz or less" : `${f.maxTmdsCharRate5MHz * 5} MHz`) : "none";
}

/** Multiset difference: items of `a` not matched in `b`, in order. */
function minus(a: readonly string[], b: readonly string[]): string[] {
  const left = [...b];
  return a.filter((x) => {
    const i = left.indexOf(x);
    if (i === -1) return true;
    left.splice(i, 1);
    return false;
  });
}

/** What changed from `before` to `after`, one plain-language line per change. Empty when nothing did. */
export function describeChanges(before: Edid, after: Edid): string[] {
  const out: string[] = [];
  const a = before.base;
  const b = after.base;
  change(out, "Manufacturer", manufacturerId(a.manufacturerCode), manufacturerId(b.manufacturerCode));
  change(out, "Product code", `0x${a.productCode.toString(16).padStart(4, "0")}`, `0x${b.productCode.toString(16).padStart(4, "0")}`);
  change(out, "Serial number", String(a.serialNumber), String(b.serialNumber));
  change(out, "Week and year", `week ${a.week}, ${a.yearOffset + 1990}`, `week ${b.week}, ${b.yearOffset + 1990}`);
  change(out, "EDID version", `${a.version}.${a.revision}`, `${b.version}.${b.revision}`);
  change(out, "Monitor name", text(before, 0xfc), text(after, 0xfc));
  change(out, "Serial text", text(before, 0xff), text(after, 0xff));
  change(out, "Video input byte", `0x${a.videoInput.toString(16).padStart(2, "0")}`, `0x${b.videoInput.toString(16).padStart(2, "0")}`);
  change(out, "Feature byte", `0x${a.features.toString(16).padStart(2, "0")}`, `0x${b.features.toString(16).padStart(2, "0")}`);
  if (a.chromaticity.join() !== b.chromaticity.join()) out.push("Colour characteristics changed");
  change(out, "Preferred timing", preferred(before), preferred(after));
  change(out, "Range limits", range(before), range(after));

  const ma = modeLabels(before);
  const mb = modeLabels(after);
  for (const m of minus(ma, mb)) out.push(`Removed ${m}`);
  for (const m of minus(mb, ma)) out.push(`Added ${m}`);

  const kinds = (e: Edid) => e.extensions.map((x) => (x.kind === "cta" ? "CTA-861" : x.kind === "displayid" ? "DisplayID" : `extension 0x${(x.bytes[0] ?? 0).toString(16).padStart(2, "0")}`));
  change(out, "Extension blocks", kinds(before).join(", ") || "none", kinds(after).join(", ") || "none");

  const ca = firstCta(before);
  const cb = firstCta(after);
  if (ca && cb) {
    change(out, "Underscan", yesNo(ca.underscan), yesNo(cb.underscan));
    change(out, "Basic audio", yesNo(ca.basicAudio), yesNo(cb.basicAudio));
    change(out, "YCbCr 4:4:4", yesNo(ca.ycbcr444), yesNo(cb.ycbcr444));
    change(out, "YCbCr 4:2:2", yesNo(ca.ycbcr422), yesNo(cb.ycbcr422));
    // Video blocks are covered by the mode list above.
    const names = (c: CtaExtension) => c.dataBlocks.filter((x) => x.kind !== "video" && x.kind !== "ycbcr420Video").map(dataBlockName);
    for (const n of minus(names(ca), names(cb))) out.push(`Removed ${n}`);
    for (const n of minus(names(cb), names(ca))) out.push(`Added ${n}`);
  }

  const va = blockOf(before, "hdmiVsdb");
  const vb = blockOf(after, "hdmiVsdb");
  if (va && vb) {
    change(out, "HDMI physical address", pa(va), pa(vb));
    change(out, "HDMI VSDB max TMDS", `${(va.maxTmdsClock5MHz ?? 0) * 5} MHz`, `${(vb.maxTmdsClock5MHz ?? 0) * 5} MHz`);
  }
  change(out, "HDMI deep colour", depths(advertisedColour(before).depths), depths(advertisedColour(after).depths));
  change(out, "4:2:0 deep colour", depths(advertisedColour(before).depths420), depths(advertisedColour(after).depths420));
  const fa = blockOf(before, "hdmiForumVsdb");
  const fb = blockOf(after, "hdmiForumVsdb");
  if (fa && fb) {
    change(out, "HDMI Forum max TMDS", forumRate(fa), forumRate(fb));
    change(out, "SCDC", yesNo(fa.scdcPresent), yesNo(fb.scdcPresent));
  }
  return out;
}
