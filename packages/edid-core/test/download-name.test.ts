import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkUploadName, downloadFileName, importEdid } from "../src/index.ts";
import type { Edid } from "../src/index.ts";
import { CORPUS_DIR } from "./corpus.ts";

const dell = importEdid(new Uint8Array(readFileSync(join(CORPUS_DIR, "edid-decode/dell-p2415q-hdmi2.0")))).edid;

function withName(edid: Edid, text: string | undefined): Edid {
  return {
    ...edid,
    base: {
      ...edid.base,
      descriptors: edid.base.descriptors.map((d) =>
        d.kind === "text" && d.tag === 0xfc ? (text === undefined ? { kind: "dummy" } : { ...d, text }) : d,
      ),
    },
  };
}

describe("download file names", () => {
  it("uses the monitor name, .txt for hex and .bin for binary", () => {
    expect(downloadFileName(dell, "hex")).toBe("DELL-P2415Q.txt");
    expect(downloadFileName(dell, "binary")).toBe("DELL-P2415Q.bin");
  });

  it("falls back to manufacturer and product code", () => {
    expect(downloadFileName(withName(dell, undefined), "hex")).toBe("DEL-a0c5.txt");
  });

  it.each([
    ["../../evil", "evil.txt"],
    ["a\\b/c:d*e?f", "a-b-c-d-e-f.txt"],
    ["\u001b[2Jx", "2Jx.txt"],
    ["CON", "edid-CON.txt"],
    ["nul.x", "edid-nul.x.txt"],
    ["   ", "edid.txt"],
    ["<script>", "script.txt"],
  ])("makes %j safe", (text, expected) => {
    expect(downloadFileName(withName(dell, text), "hex")).toBe(expected);
  });

  it("is always accepted back as an upload", () => {
    for (const text of ["../../evil", "CON", "\u0000", "Tessera SX40", ".hidden"]) {
      expect(() => checkUploadName(downloadFileName(withName(dell, text), "hex"))).not.toThrow();
    }
  });
});
