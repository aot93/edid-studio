// Export formats for `edidtool convert` (SPEC.md section 5): C array and
// base64, and base64 import. Hex and binary are covered in hex.test.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EdidParseError, exportEdid, importEdid } from "../src/index.ts";
import { CORPUS_DIR } from "./corpus.ts";

const bytes = new Uint8Array(readFileSync(join(CORPUS_DIR, "edid-decode", "dell-p2415q-hdmi2.0")));
const { edid } = importEdid(bytes);

describe("C array", () => {
  it("is a compilable array that imports back to the same bytes", () => {
    const c = exportEdid(edid, "c");
    expect(c.startsWith("unsigned char edid[256] = {\n  0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00,")).toBe(true);
    expect(c.trimEnd().endsWith("};")).toBe(true);
    expect(importEdid(c).bytes).toEqual(bytes);
  });
});

describe("base64", () => {
  it("round-trips, and is recognised by its encoded header (AP///////wA)", () => {
    const b64 = exportEdid(edid, "base64");
    expect(b64.startsWith("AP///////wA")).toBe(true);
    expect(b64).toBe(Buffer.from(bytes).toString("base64") + "\n");
    expect(importEdid(b64).bytes).toEqual(bytes);
    expect(importEdid(b64).format).toBe("base64");
  });

  it("accepts line-wrapped base64, and refuses broken base64 as an EdidParseError", () => {
    const wrapped = Buffer.from(bytes).toString("base64").replace(/(.{76})/g, "$1\n");
    expect(importEdid(wrapped).bytes).toEqual(bytes);
    expect(() => importEdid("AP///////wA!!!")).toThrow(EdidParseError);
  });
});
