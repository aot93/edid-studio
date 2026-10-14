import { describe, expect, it } from "vitest";
import { edidLayout, serializeEdid } from "../src/index.ts";
import type { LayoutNode } from "../src/index.ts";
import { corpusFiles } from "./corpus.ts";
import { importEdid } from "../src/index.ts";

describe("layout", () => {
  it("children tile each block exactly, for every corpus EDID", () => {
    for (const file of corpusFiles()) {
      const { edid } = importEdid(file.data);
      const blocks = edidLayout(edid);
      expect(blocks.length * 128).toBe(serializeEdid(edid).length);
      blocks.forEach((b: LayoutNode, i) => {
        expect([b.start, b.end]).toEqual([i * 128, (i + 1) * 128]);
        let at = b.start;
        for (const c of b.children) {
          expect(c.start, `${file.name} ${c.id}`).toBe(at);
          expect(c.end).toBeGreaterThan(c.start);
          at = c.end;
        }
        expect(at).toBe(b.end);
      });
      const ids = blocks.flatMap((b) => [b.id, ...b.children.map((c) => c.id)]);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
