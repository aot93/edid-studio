// Byte ranges of every model node, for highlighting in the UI's hex view.
// Offsets follow the serializer, so they match `serializeEdid(edid)`.

import { BLOCK_SIZE } from "./bytes.ts";
import { serializeDataBlock } from "./cta.ts";
import { DESCRIPTOR_SIZE } from "./descriptors.ts";
import { serializeDisplayIdDataBlock } from "./displayid.ts";
import type { Edid } from "./model.ts";

export type NodeRef =
  | { readonly type: "block"; readonly block: number }
  | { readonly type: "baseHeader" }
  | { readonly type: "baseIdentity" }
  | { readonly type: "baseVersion" }
  | { readonly type: "baseDisplay" }
  | { readonly type: "chromaticity" }
  | { readonly type: "establishedTimings" }
  | { readonly type: "standardTimings" }
  | { readonly type: "baseDescriptor"; readonly index: number }
  | { readonly type: "extensionCount" }
  | { readonly type: "checksum"; readonly block: number }
  | { readonly type: "ctaHeader"; readonly extension: number }
  | { readonly type: "dataBlock"; readonly extension: number; readonly index: number }
  | { readonly type: "ctaDescriptor"; readonly extension: number; readonly index: number }
  | { readonly type: "displayIdHeader"; readonly extension: number }
  | { readonly type: "displayIdBlock"; readonly extension: number; readonly index: number }
  | { readonly type: "displayIdFiller"; readonly extension: number }
  | { readonly type: "displayIdChecksum"; readonly extension: number }
  | { readonly type: "padding"; readonly block: number }
  | { readonly type: "rawExtension"; readonly extension: number };

export interface LayoutNode {
  /** Stable for a given model shape, for React keys and selection. */
  readonly id: string;
  readonly ref: NodeRef;
  /** Absolute byte offset, inclusive. */
  readonly start: number;
  /** Absolute byte offset, exclusive. */
  readonly end: number;
  readonly children: readonly LayoutNode[];
}

function node(ref: NodeRef, start: number, end: number, children: LayoutNode[] = []): LayoutNode {
  const id = Object.entries(ref)
    .map(([, v]) => String(v))
    .join(":");
  return { id, ref, start, end, children };
}

/** One node per block, with that block's parts as children. */
export function edidLayout(edid: Edid): LayoutNode[] {
  const base = node({ type: "block", block: 0 }, 0, BLOCK_SIZE, [
    node({ type: "baseHeader" }, 0, 8),
    node({ type: "baseIdentity" }, 8, 18),
    node({ type: "baseVersion" }, 18, 20),
    node({ type: "baseDisplay" }, 20, 25),
    node({ type: "chromaticity" }, 25, 35),
    node({ type: "establishedTimings" }, 35, 38),
    node({ type: "standardTimings" }, 38, 54),
    ...edid.base.descriptors.map((_, i) =>
      node({ type: "baseDescriptor", index: i }, 54 + i * DESCRIPTOR_SIZE, 54 + (i + 1) * DESCRIPTOR_SIZE),
    ),
    node({ type: "extensionCount" }, 126, 127),
    node({ type: "checksum", block: 0 }, 127, 128),
  ]);

  const extensions = edid.extensions.map((ext, e) => {
    const block = e + 1;
    const at = block * BLOCK_SIZE;
    const checksum = node({ type: "checksum", block }, at + BLOCK_SIZE - 1, at + BLOCK_SIZE);
    if (ext.kind === "raw") {
      return node({ type: "block", block }, at, at + BLOCK_SIZE, [
        node({ type: "rawExtension", extension: e }, at, at + BLOCK_SIZE - 1),
        checksum,
      ]);
    }
    if (ext.kind === "displayid") {
      // Tag and section header (bytes 0-4), data blocks, filler, section checksum, padding.
      const children: LayoutNode[] = [node({ type: "displayIdHeader", extension: e }, at, at + 5)];
      let offset = at + 5;
      ext.dataBlocks.forEach((b, i) => {
        const length = serializeDisplayIdDataBlock(b).length;
        children.push(node({ type: "displayIdBlock", extension: e, index: i }, offset, offset + length));
        offset += length;
      });
      if (ext.filler > 0) children.push(node({ type: "displayIdFiller", extension: e }, offset, offset + ext.filler));
      offset += ext.filler;
      children.push(node({ type: "displayIdChecksum", extension: e }, offset, offset + 1));
      if (offset + 1 < at + BLOCK_SIZE - 1) children.push(node({ type: "padding", block }, offset + 1, at + BLOCK_SIZE - 1));
      children.push(checksum);
      return node({ type: "block", block }, at, at + BLOCK_SIZE, children);
    }
    const children: LayoutNode[] = [node({ type: "ctaHeader", extension: e }, at, at + 4)];
    let offset = at + 4;
    ext.dataBlocks.forEach((b, i) => {
      const length = serializeDataBlock(b).length;
      children.push(node({ type: "dataBlock", extension: e, index: i }, offset, offset + length));
      offset += length;
    });
    ext.descriptors.forEach((_, i) => {
      children.push(node({ type: "ctaDescriptor", extension: e, index: i }, offset, offset + DESCRIPTOR_SIZE));
      offset += DESCRIPTOR_SIZE;
    });
    if (offset < at + BLOCK_SIZE - 1) children.push(node({ type: "padding", block }, offset, at + BLOCK_SIZE - 1));
    children.push(checksum);
    return node({ type: "block", block }, at, at + BLOCK_SIZE, children);
  });

  return [base, ...extensions];
}
