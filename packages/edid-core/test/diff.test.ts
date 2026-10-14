import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { byteDiff, importEdid, removeSvd, serializeEdid } from "../src/index.ts";
import { CORPUS_DIR } from "./corpus.ts";

describe("byteDiff", () => {
  it("identical input has no changes", () => {
    const a = new Uint8Array(256).map((_, i) => i & 0xff);
    expect(byteDiff(a, a)).toEqual({ changed: new Array(256).fill(false), removed: 0, added: 0 });
  });

  it("a single removed byte does not mark later bytes changed", () => {
    const before = Uint8Array.from({ length: 128 }, (_, i) => i);
    const after = Uint8Array.from([...before.slice(0, 10), ...before.slice(11), 0xee]);
    const d = byteDiff(before, after);
    expect(d.removed).toBe(1);
    expect(d.added).toBe(1);
    expect(d.changed.findIndex(Boolean)).toBe(127);
  });

  it("removing a VIC changes a handful of bytes, not the rest of the block", () => {
    const { edid, bytes } = importEdid(new Uint8Array(readFileSync(join(CORPUS_DIR, "edid-decode/dell-p2415q-hdmi2.0"))));
    const vdb = edid.extensions[0]?.kind === "cta" ? edid.extensions[0].dataBlocks.findIndex((b) => b.kind === "video") : -1;
    const after = serializeEdid(removeSvd(edid, 0, vdb, 0));
    const d = byteDiff(bytes, after);
    // The SVD byte goes; the DTD offset, block length, 4:2:0 map and checksum change.
    expect(d.removed).toBeLessThanOrEqual(6);
    expect(d.added).toBeLessThanOrEqual(6);
  });

  it("counts whole extra or missing blocks", () => {
    const one = new Uint8Array(128);
    const two = new Uint8Array(256);
    expect(byteDiff(one, two).added).toBe(128);
    expect(byteDiff(two, one).removed).toBe(128);
  });
});
