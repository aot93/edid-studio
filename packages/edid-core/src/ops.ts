// Pure edit operations. Each returns a new model and leaves the input
// untouched; serializeEdid checks the result. Recipes (M3) will log these.

import { EdidEncodeError } from "./errors.ts";
import type { CtaExtension, DataBlock, Descriptor, Edid, HdmiForumVsdb, HdmiVsdbCapabilities } from "./model.ts";

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
