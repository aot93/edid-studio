// Acceptance test 5: every fixture parses and serializes to identical bytes.

import { describe, expect, it } from "vitest";
import { importEdid, serializeEdid } from "../src/index.ts";
import { corpusFiles, fixtureFiles } from "./corpus.ts";

const files = [...corpusFiles(), ...fixtureFiles()];

describe("round-trip", () => {
  it("has a corpus to test", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  for (const file of files) {
    it(file.name, () => {
      const imported = importEdid(file.data);
      const out = serializeEdid(imported.edid);
      if (imported.checksumErrors.length > 0) {
        // Corrupted inputs: everything but the checksum bytes must survive.
        expect(out.length).toBe(imported.bytes.length);
        for (let i = 0; i < out.length; i++) if (i % 128 !== 127) expect(out[i]).toBe(imported.bytes[i]);
      } else {
        expect(Buffer.from(out).equals(Buffer.from(imported.bytes))).toBe(true);
      }
    });
  }
});
