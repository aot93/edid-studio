// Editing the model changes only the bytes the edit is about.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EdidEncodeError, importEdid, manufacturerId, encodeManufacturerId, serializeEdid } from "../src/index.ts";
import type { CtaExtension, Edid } from "../src/index.ts";
import { CORPUS_DIR } from "./corpus.ts";

const source = importEdid(new Uint8Array(readFileSync(join(CORPUS_DIR, "edid-decode/dell-p2415q-hdmi2.0"))));

function changedOffsets(a: Uint8Array, b: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

function mapCta(edid: Edid, f: (cta: CtaExtension) => CtaExtension): Edid {
  return { ...edid, extensions: edid.extensions.map((e) => (e.kind === "cta" ? f(e) : e)) };
}

describe("model edits", () => {
  it("setting DC_30bit touches one byte and the checksum", () => {
    const edited = mapCta(source.edid, (cta) => ({
      ...cta,
      dataBlocks: cta.dataBlocks.map((b) =>
        b.kind === "hdmiVsdb" && b.capabilities ? { ...b, capabilities: { ...b.capabilities, dc30bit: true } } : b,
      ),
    }));
    const vsdb = source.edid.extensions[0]?.kind === "cta" ? source.edid.extensions[0].dataBlocks.find((b) => b.kind === "hdmiVsdb") : undefined;
    expect(vsdb?.kind === "hdmiVsdb" && vsdb.capabilities?.dc30bit).toBe(false);
    const changed = changedOffsets(source.bytes, serializeEdid(edited));
    expect(changed).toHaveLength(2);
    expect(changed[1]).toBe(255);
  });

  it("removing a data block moves the DTD offset and keeps the block valid", () => {
    const edited = mapCta(source.edid, (cta) => ({ ...cta, dataBlocks: cta.dataBlocks.filter((b) => b.kind !== "video") }));
    const out = serializeEdid(edited);
    expect(out.length).toBe(256);
    const reparsed = importEdid(out);
    expect(reparsed.checksumErrors).toEqual([]);
    expect(reparsed.edid).toEqual(edited);
  });

  it("refuses a CTA block that no longer fits in 127 bytes", () => {
    const edited = mapCta(source.edid, (cta) => ({ ...cta, descriptors: [...cta.descriptors, ...cta.descriptors, ...cta.descriptors, ...cta.descriptors] }));
    expect(() => serializeEdid(edited)).toThrow(EdidEncodeError);
  });

  it("decodes and encodes the manufacturer ID", () => {
    expect(manufacturerId(source.edid.base.manufacturerCode)).toBe("DEL");
    expect(encodeManufacturerId("DEL")).toBe(source.edid.base.manufacturerCode);
    expect(() => encodeManufacturerId("de1")).toThrow(EdidEncodeError);
  });
});
