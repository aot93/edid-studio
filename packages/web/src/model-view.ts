// Turns model nodes into labels and lookups for the UI. All EDID text goes
// through printable() and is rendered as React text, never as HTML.

import { describeDisplayIdTiming, describeDtd, lookupVic, manufacturerId, modeLabel, printable } from "@edid-studio/core";
import type { CtaExtension, DataBlock, Descriptor, DisplayIdDataBlock, DisplayIdExtension, Edid, LayoutNode, NodeRef } from "@edid-studio/core";

export function ctaAt(edid: Edid, extension: number): CtaExtension | undefined {
  const e = edid.extensions[extension];
  return e?.kind === "cta" ? e : undefined;
}

export function displayIdAt(edid: Edid, extension: number): DisplayIdExtension | undefined {
  const e = edid.extensions[extension];
  return e?.kind === "displayid" ? e : undefined;
}

export function displayIdBlockAt(edid: Edid, ref: NodeRef): DisplayIdDataBlock | undefined {
  return ref.type === "displayIdBlock" ? displayIdAt(edid, ref.extension)?.dataBlocks[ref.index] : undefined;
}

/** DisplayID 1.3 and 2.0 data block tags (edid-decode displayid_block()). */
const DISPLAYID_TAGS: Record<number, string> = {
  0x00: "Product identification",
  0x01: "Display parameters",
  0x02: "Colour characteristics",
  0x03: "Type I detailed timings",
  0x04: "Type II detailed timings",
  0x05: "Type III short timings",
  0x06: "Type IV DMT timings",
  0x07: "VESA DMT timings",
  0x08: "CTA-861 timings",
  0x09: "Video timing range",
  0x0a: "Product serial number",
  0x0b: "ASCII string",
  0x0c: "Display device data",
  0x0f: "Display interface",
  0x12: "Tiled display topology",
  0x20: "Product identification (2.0)",
  0x21: "Display parameters (2.0)",
  0x22: "Type VII detailed timings",
  0x26: "Display interface features",
  0x28: "Tiled display topology (2.0)",
  0x29: "ContainerID",
  0x2b: "Adaptive sync",
  0x7e: "Vendor-specific (2.0)",
  0x7f: "Vendor-specific",
  0x81: "CTA-861 data",
};

export function displayIdBlockLabel(b: DisplayIdDataBlock): string {
  if (b.kind === "type1Timings") {
    const first = b.timings[0];
    return b.timings.length === 1 && first ? `Timing ${modeLabel(describeDisplayIdTiming(first))}` : `Type I detailed timings (${b.timings.length})`;
  }
  const tag = b.bytes[0] ?? 0;
  return DISPLAYID_TAGS[tag] ?? `DisplayID block 0x${hex(tag)}`;
}

export function descriptorAt(edid: Edid, ref: NodeRef): Descriptor | undefined {
  if (ref.type === "baseDescriptor") return edid.base.descriptors[ref.index];
  if (ref.type === "ctaDescriptor") return ctaAt(edid, ref.extension)?.descriptors[ref.index];
  return undefined;
}

export function dataBlockAt(edid: Edid, ref: NodeRef): DataBlock | undefined {
  return ref.type === "dataBlock" ? ctaAt(edid, ref.extension)?.dataBlocks[ref.index] : undefined;
}

const TEXT_TAGS: Record<number, string> = { 0xfc: "Monitor name", 0xfe: "Text", 0xff: "Serial number" };
const EXTENDED_TAGS: Record<number, string> = {
  0x00: "Video capability",
  0x05: "Colorimetry",
  0x06: "HDR static metadata",
  0x07: "HDR dynamic metadata",
  0x0d: "Video format preference",
  0x0e: "YCbCr 4:2:0 video",
  0x0f: "YCbCr 4:2:0 capability map",
  0x78: "HDMI Forum EEODB",
  0x79: "HDMI Forum SCDB",
};
const TAGS: Record<number, string> = { 1: "Audio", 2: "Video", 3: "Vendor-specific", 4: "Speaker allocation", 5: "VESA DTC", 6: "Video format" };

export function descriptorLabel(d: Descriptor): string {
  switch (d.kind) {
    case "dtd":
      return `Timing ${modeLabel(describeDtd(d))}`;
    case "text":
      return `${TEXT_TAGS[d.tag] ?? "Text"} "${printable(d.text, 24)}"`;
    case "rangeLimits":
      return "Range limits";
    case "dummy":
      return "Unused (dummy)";
    case "raw":
      return d.bytes[0] === 0 && d.bytes[1] === 0 ? `Descriptor 0x${hex(d.bytes[3] ?? 0)}` : "Descriptor";
  }
}

export function dataBlockLabel(b: DataBlock): string {
  switch (b.kind) {
    case "video":
      return `Video modes (${b.svds.length})`;
    case "ycbcr420Video":
      return `4:2:0-only modes (${b.svds.length})`;
    case "ycbcr420CapabilityMap":
      return "4:2:0 capability map";
    case "videoCapability":
      return "Video capability";
    case "hdmiVsdb":
      return "HDMI 1.4 VSDB";
    case "hdmiForumVsdb":
      return "HDMI Forum VSDB";
    case "raw": {
      const tag = (b.bytes[0] ?? 0) >> 5;
      if (tag === 7) return EXTENDED_TAGS[b.bytes[1] ?? -1] ?? `Extended block 0x${hex(b.bytes[1] ?? 0)}`;
      if (tag === 3 && b.bytes.length >= 4) {
        const oui = [b.bytes[3], b.bytes[2], b.bytes[1]].map((v) => hex(v ?? 0).toUpperCase()).join("-");
        return `Vendor block ${oui}`;
      }
      return `${TAGS[tag] ?? "Data"} block`;
    }
  }
}

export function nodeLabel(edid: Edid, node: LayoutNode): string {
  const r = node.ref;
  switch (r.type) {
    case "block": {
      if (r.block === 0) return "Block 0 · Base EDID";
      const ext = edid.extensions[r.block - 1];
      if (ext?.kind === "cta") return `Block ${r.block} · CTA-861`;
      if (ext?.kind === "displayid") return `Block ${r.block} · DisplayID ${ext.version >> 4}.${ext.version & 0xf}`;
      return `Block ${r.block} · ${extensionName(ext?.bytes[0])}`;
    }
    case "baseHeader":
      return "Header";
    case "baseIdentity":
      return `Identity ${manufacturerId(edid.base.manufacturerCode)}`;
    case "baseVersion":
      return `EDID ${edid.base.version}.${edid.base.revision}`;
    case "baseDisplay":
      return "Display parameters";
    case "chromaticity":
      return "Colour characteristics";
    case "establishedTimings":
      return "Established timings";
    case "standardTimings":
      return "Standard timings";
    case "baseDescriptor":
    case "ctaDescriptor": {
      const d = descriptorAt(edid, r);
      return d ? descriptorLabel(d) : "Descriptor";
    }
    case "extensionCount":
      return `Extension count`;
    case "checksum":
      return "Checksum";
    case "ctaHeader":
      return "CTA header";
    case "dataBlock": {
      const b = dataBlockAt(edid, r);
      return b ? dataBlockLabel(b) : "Data block";
    }
    case "displayIdHeader":
      return "DisplayID header";
    case "displayIdBlock": {
      const b = displayIdBlockAt(edid, r);
      return b ? displayIdBlockLabel(b) : "DisplayID data block";
    }
    case "displayIdFiller":
      return "Filler";
    case "displayIdChecksum":
      return "DisplayID checksum";
    case "padding":
      return "Padding";
    case "rawExtension":
      return "Extension data (raw)";
  }
}

function extensionName(tag: number | undefined): string {
  switch (tag) {
    case 0x70:
      return "DisplayID";
    case 0xf0:
      return "Block map";
    case 0x02:
      return "CTA-861 (older revision)";
    default:
      return `Extension 0x${hex(tag ?? 0)}`;
  }
}

/** True when the node is kept as raw bytes rather than decoded. */
export function isRaw(edid: Edid, ref: NodeRef): boolean {
  if (ref.type === "rawExtension") return true;
  return descriptorAt(edid, ref)?.kind === "raw" || dataBlockAt(edid, ref)?.kind === "raw" || displayIdBlockAt(edid, ref)?.kind === "raw";
}

export function svdLabel(vic: number): string {
  const v = lookupVic(vic);
  return v ? modeLabel(v) : "Unknown VIC";
}

export function hex(v: number, width = 2): string {
  return v.toString(16).padStart(width, "0");
}

/** The first DTD: the preferred timing when the base block says so. */
export function preferredTiming(edid: Edid): Descriptor | undefined {
  return edid.base.descriptors.find((d) => d.kind === "dtd");
}

export function monitorName(edid: Edid): string | undefined {
  const d = edid.base.descriptors.find((x) => x.kind === "text" && x.tag === 0xfc);
  return d?.kind === "text" ? d.text : undefined;
}

/** All nodes, flattened, deepest last, for hit-testing a byte offset. */
export function nodeAtOffset(layout: readonly LayoutNode[], offset: number): LayoutNode | undefined {
  for (const block of layout) {
    if (offset < block.start || offset >= block.end) continue;
    return block.children.find((c) => offset >= c.start && offset < c.end) ?? block;
  }
  return undefined;
}
