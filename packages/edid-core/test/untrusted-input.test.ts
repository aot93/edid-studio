// Uploaded files and pasted text are untrusted once the UI is public.
// Every input must either parse or fail with EdidParseError, quickly.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkUploadName,
  EdidInputError,
  EdidParseError,
  formatHex,
  importEdid,
  importUpload,
  MAX_EDID_BYTES,
  MAX_INPUT_BYTES,
  parseEdid,
  printable,
  serializeEdid,
} from "../src/index.ts";
import type { InputRejection } from "../src/index.ts";
import { CORPUS_DIR } from "./corpus.ts";

const reference = new Uint8Array(readFileSync(join(CORPUS_DIR, "edid-decode/dell-p2415q-hdmi2.0")));

function rejection(f: () => unknown): InputRejection | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof EdidInputError) return e.reason;
    throw e;
  }
  return undefined;
}

/** Deterministic PRNG (mulberry32) so failures reproduce. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Imports `input`; it must succeed and round-trip, or throw EdidParseError. */
function importSafely(input: Uint8Array | string): void {
  let imported;
  try {
    imported = importEdid(input);
  } catch (e) {
    expect(e).toBeInstanceOf(EdidParseError);
    return;
  }
  const out = serializeEdid(imported.edid);
  expect(parseEdid(out)).toEqual(imported.edid);
}

describe("upload checks", () => {
  it("accepts an uploaded binary and hex text", () => {
    expect(importUpload({ name: "display.bin", bytes: reference }).bytes).toEqual(reference);
    const hex = new TextEncoder().encode(formatHex(reference));
    expect(importUpload({ name: "display.txt", bytes: hex }).bytes).toEqual(reference);
    expect(importUpload({ name: "no-extension", bytes: reference }).bytes).toEqual(reference);
  });

  it.each([
    ["image.png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a], "PNG"],
    ["archive.bin", [0x50, 0x4b, 0x03, 0x04, 0, 0], "ZIP"],
    ["setup.bin", [0x4d, 0x5a, 0x90, 0, 3, 0], "Windows executable"],
    ["doc.txt", [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31], "PDF"],
    ["prog.dat", [0x7f, 0x45, 0x4c, 0x46, 2, 1], "Linux executable"],
  ])("names and refuses %s by content", (_, magic, kind) => {
    const bytes = new Uint8Array(256);
    bytes.set(magic);
    expect(() => importEdid(bytes)).toThrow(kind);
  });

  it.each([
    ["display.exe", "unsupported-extension"],
    ["display.html", "unsupported-extension"],
    ["display.svg", "unsupported-extension"],
    ["../../etc/passwd", "bad-file-name"],
    ["C:\\temp\\x.bin", "bad-file-name"],
    ["evil\u0000.bin", "bad-file-name"],
    ["evil\u001b[31m.bin", "bad-file-name"],
    ["", "bad-file-name"],
    ["a".repeat(256) + ".bin", "bad-file-name"],
  ])("refuses the file name %j", (name, reason) => {
    expect(rejection(() => checkUploadName(name))).toBe(reason);
  });

  it("accepts ordinary names, any case", () => {
    for (const name of ["Tessera-EJE-test.txt", "EDID.BIN", "lg-c8-hdmi", "out.hex", "edid.h"]) {
      expect(() => checkUploadName(name)).not.toThrow();
    }
  });
});

describe("size limits", () => {
  it("refuses a file over the input limit before reading it", () => {
    expect(rejection(() => importEdid(new Uint8Array(MAX_INPUT_BYTES + 1)))).toBe("too-large");
    expect(rejection(() => importEdid("0".repeat(MAX_INPUT_BYTES + 1)))).toBe("too-large");
  });

  it("refuses hex that decodes to more than the largest EDID", () => {
    expect(rejection(() => importEdid("00".repeat(MAX_EDID_BYTES + 1)))).toBe("too-many-bytes");
  });

  it("refuses large non-text input cleanly instead of crashing", () => {
    // Regression: a 300 kB buffer overflowed the call stack.
    expect(rejection(() => importEdid(new Uint8Array(300_000).fill(0x80)))).toBe("not-text");
    expect(() => importEdid(new Uint8Array(300_000).fill(0x30))).toThrow(EdidParseError);
  });
});

describe("messages never echo raw input", () => {
  it("escapes control characters and cuts long tokens", () => {
    let message = "";
    try {
      importEdid(`00 ff \u001b[2J${"z".repeat(5000)}`);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("\\x1b[2J");
    expect(message).not.toContain("\u001b");
    expect(message.length).toBeLessThan(200);
  });

  it("printable() keeps ASCII and escapes the rest", () => {
    expect(printable("Tessera SX40")).toBe("Tessera SX40");
    expect(printable("a\u0000b\u001bc\\d\u00e9\u{1f600}")).toBe("a\\x00b\\x1bc\\\\d\\xe9\\u{1f600}");
    expect(printable("x".repeat(100), 10)).toBe("xxxxxxxxxx...");
  });

  it("a monitor name with an escape sequence decodes but prints safely", () => {
    const evil = Uint8Array.from(reference);
    // Put ESC into the first character of the product name descriptor.
    const nameAt = [0x36, 0x48, 0x5a, 0x6c].find((o) => evil[o + 3] === 0xfc) ?? -1;
    expect(nameAt).toBeGreaterThan(0);
    evil[nameAt + 5] = 0x1b;
    const edid = parseEdid(evil);
    const name = edid.base.descriptors.find((d) => d.kind === "text" && d.tag === 0xfc);
    expect(name?.kind === "text" && printable(name.text)).toMatch(/^\\x1b/);
  });
});

describe("pathological input finishes quickly", () => {
  it.each([
    ["unterminated comments", "/*".repeat(100_000)],
    ["hexdump-like line with no ASCII column", "00000000  " + "00 ".repeat(100_000)],
    ["long whitespace runs", "00" + " ".repeat(200_000) + "x"],
    ["edid-decode marker then junk", "edid-decode (hex):\n" + "00 ".repeat(100_000) + "zz"],
    ["comma storm", ", ".repeat(200_000)],
    ["offset-like prefixes", "0:".repeat(200_000)],
  ])("%s", (_, text) => {
    const start = performance.now();
    expect(() => importEdid(text)).toThrow(EdidParseError);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("fuzz", () => {
  it("random buffers", () => {
    const r = rng(1);
    for (let n = 0; n < 500; n++) {
      const bytes = new Uint8Array(Math.floor(r() * 1024));
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(r() * 256);
      importSafely(bytes);
    }
  });

  it("random text from hex-like characters", () => {
    const r = rng(2);
    const alphabet = "0123456789abcdefABCDEFx ,;:|{}\n\t#/*-'\"";
    for (let n = 0; n < 500; n++) {
      let s = "";
      const len = Math.floor(r() * 2000);
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(r() * alphabet.length)];
      importSafely(s);
    }
  });

  it("valid EDIDs with corrupted bytes", () => {
    const r = rng(3);
    const seeds = ["dell-p2415q-hdmi2.0", "samsung-q800t-hdmi2.1", "lg-oled-c9-hdmi", "apple-xdr-6k", "sharp-lc70uq17u-vga"].map(
      (f) => new Uint8Array(readFileSync(join(CORPUS_DIR, "edid-decode", f))),
    );
    for (let n = 0; n < 3000; n++) {
      const seed = seeds[n % seeds.length] ?? reference;
      const bytes = Uint8Array.from(seed);
      const flips = 1 + Math.floor(r() * 8);
      for (let k = 0; k < flips; k++) {
        // Keep the header so the parser goes deep, but corrupt anything else,
        // extension counts and data block lengths included.
        const at = 8 + Math.floor(r() * (bytes.length - 8));
        bytes[at] = Math.floor(r() * 256);
      }
      importSafely(bytes);
    }
  });
});
