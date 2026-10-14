import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EdidParseError, formatHex, importEdid, parseHex } from "../src/index.ts";
import { CORPUS_DIR } from "./corpus.ts";

const reference = new Uint8Array(readFileSync(join(CORPUS_DIR, "edid-decode/dell-p2415q-hdmi2.0")));
const layout = (name: string) => readFileSync(join(CORPUS_DIR, "layouts", name), "utf8");

describe("hex import, real tool output", () => {
  // Each sample was produced from dell-p2415q-hdmi2.0 by the named tool.
  for (const name of ["xxd.txt", "hexdump-c.txt", "edid-decode-output.txt", "c-array.h"]) {
    it(name, () => {
      expect(parseHex(layout(name)).bytes).toEqual(reference);
    });
  }

  it("refuses hexdump output with collapsed repeated lines", () => {
    const collapsed = "00000000  00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 00  |................|\n*\n00000080\n";
    expect(() => parseHex(collapsed)).toThrow(/hexdump -v -C/);
  });
});

describe("hex import, hand-written layouts", () => {
  const first = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];

  it.each([
    ["spaces", "00 ff ff ff ff ff ff 00"],
    ["commas and 0x", "0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00"],
    ["one long string", "00ffffffffffff00"],
    ["offset with colon", "0000: 00 ff ff ff ff ff ff 00"],
    ["offset with bar", "00 | 00 ff ff ff ff ff ff 00"],
    ["0x offset", "0x00: 00 ff ff ff ff ff ff 00"],
    ["tabs and trailing comment", "00\tff ff ff ff ff ff 00 # header"],
  ])("%s", (_, text) => {
    expect([...parseHex(text).bytes]).toEqual(first);
  });

  it("names the line and token it cannot read", () => {
    expect(() => parseHex("00 ff ff\nff ff fg ff 00")).toThrow(/line 2: "fg" is not a hex byte/);
  });

  it("refuses odd-length tokens rather than guessing", () => {
    expect(() => parseHex("00 ff f ff")).toThrow(EdidParseError);
  });

  it("refuses a mix of prefixed and bare bytes", () => {
    expect(() => parseHex("0x00 ff")).toThrow(/0x prefix/);
  });
});

describe("hex export mirrors input style", () => {
  it.each([
    ["lower case, 16 per line", formatHex(reference)],
    ["upper case", formatHex(reference, { uppercase: true, prefix: "", separator: " ", bytesPerLine: 16, trailingSeparator: false, blankLineBetweenBlocks: false })],
    ["C style", formatHex(reference, { uppercase: false, prefix: "0x", separator: ", ", bytesPerLine: 12, trailingSeparator: true, blankLineBetweenBlocks: false })],
    ["one line, no separator", formatHex(reference, { uppercase: true, prefix: "", separator: "", bytesPerLine: 0, trailingSeparator: false, blankLineBetweenBlocks: false })],
    ["block gaps", formatHex(reference, { uppercase: false, prefix: "", separator: " ", bytesPerLine: 16, trailingSeparator: false, blankLineBetweenBlocks: true })],
  ])("%s", (_, text) => {
    const parsed = parseHex(text);
    expect(parsed.bytes).toEqual(reference);
    expect(formatHex(parsed.bytes, parsed.style)).toBe(text);
  });

  it("reads a UTF-16 text file as Windows editors save it", () => {
    const text = "﻿" + formatHex(reference);
    const utf16 = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      utf16[i * 2] = text.charCodeAt(i) & 0xff;
      utf16[i * 2 + 1] = text.charCodeAt(i) >> 8;
    }
    expect(importEdid(utf16).bytes).toEqual(reference);
  });
});
