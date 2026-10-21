// Recipes (SPEC.md section 9): parsing untrusted JSON, every operation,
// per-step change reports, and the "expect" block.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkExpect, displayIdTimings, EdidParseError, importEdid, parseRecipe, RecipeError, runRecipeSteps, serializeEdid } from "../src/index.ts";
import { FIXTURES_DIR } from "./corpus.ts";

const fixture = (name: string) => importEdid(readFileSync(join(FIXTURES_DIR, name), "utf8"));

/** The recipe from SPEC.md section 9, verbatim, with its expect block. */
const SPEC_RECIPE = `{
  "recipe": 1,
  "base": { "file": "Tessera-EJE-test.txt" },
  "ops": [
    { "op": "keepOnlyModes", "modes": [] },
    { "op": "setPreferredTiming", "width": 3840, "height": 2160, "refresh": "50",
      "formula": "exact-refresh", "hBlank": 160, "vBlankLines": 60,
      "hFrontPorch": 48, "hSync": 32, "vFrontPorch": 8, "vSync": 10,
      "polarity": "H+V-" },
    { "op": "setColor", "formats": ["rgb"], "depths": [10] },
    { "op": "setRangeLimits", "vHz": [50, 50], "hKHz": [110, 113],
      "maxClockMHz": 600, "gtf": "none" }
  ],
  "expect": {
    "bytes": 256,
    "dtd": "70 ad 00 a0 f0 70 3c 80 30 20 8a 00 00 00 00 00 00 1a",
    "checksums": ["bf", "d6"]
  }
}`;

describe("parseRecipe", () => {
  it("reads the spec's recipe, expect block included", () => {
    const r = parseRecipe(SPEC_RECIPE);
    expect(r.ops.map((o) => o.op)).toEqual(["keepOnlyModes", "setPreferredTiming", "setColor", "setRangeLimits"]);
    expect(r.expect).toEqual({ bytes: 256, dtd: "70 ad 00 a0 f0 70 3c 80 30 20 8a 00 00 00 00 00 00 1a", checksums: ["bf", "d6"] });
    expect(r.base).toEqual({ file: "Tessera-EJE-test.txt" });
  });

  it.each([
    ["not JSON", "{", /not valid JSON/],
    ["not an object", "[]", /must be a JSON object/],
    ["wrong version", `{"recipe": 2, "ops": []}`, /recipe version/],
    ["unknown op", `{"recipe": 1, "ops": [{"op": "formatDisk"}]}`, /op 1: unknown operation "formatDisk"/],
    ["missing field", `{"recipe": 1, "ops": [{"op": "setMonitorName"}]}`, /op 1 \(setMonitorName\): "name" is required/],
    ["wrong type", `{"recipe": 1, "ops": [{"op": "setColor", "formats": "rgb", "depths": [10]}]}`, /"formats" must be a list of strings/],
    ["unknown field (a typo)", `{"recipe": 1, "ops": [{"op": "setMonitorName", "name": "x", "nmae": "y"}]}`, /unknown field "nmae"/],
    ["bad enum", `{"recipe": 1, "ops": [{"op": "setColor", "formats": ["cmyk"], "depths": [10]}]}`, /"formats".*cmyk/],
    ["base path escaping", `{"recipe": 1, "base": {"file": 7}, "ops": []}`, /"base.file" must be a string/],
  ])("refuses %s with a message naming the problem", (_, text, message) => {
    expect(() => parseRecipe(text)).toThrow(RecipeError);
    expect(() => parseRecipe(text)).toThrow(message);
  });

  it("is an EdidParseError, and escapes what it quotes", () => {
    let caught: unknown;
    try {
      parseRecipe(`{"recipe": 1, "ops": [{"op": "\\u001b[31mred"}]}`);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EdidParseError);
    expect(String((caught as Error).message)).toContain("\\x1b[31mred");
    expect(String((caught as Error).message)).not.toContain("\u001b");
  });

  it("refuses an oversized recipe before parsing it", () => {
    expect(() => parseRecipe(" ".repeat(600 * 1024))).toThrow(/limit/);
  });

  it("fuzz: random edits of a valid recipe either parse or throw RecipeError", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const chars = `{}[]":,0123456789abcdefghijklmnopqrstuvwxyz-. \\`;
    for (let n = 0; n < 2000; n++) {
      const s = [...SPEC_RECIPE];
      for (let k = 0; k < 1 + Math.floor(rnd() * 5); k++) s[Math.floor(rnd() * s.length)] = chars[Math.floor(rnd() * chars.length)] ?? " ";
      try {
        parseRecipe(s.join(""));
      } catch (e) {
        expect(e).toBeInstanceOf(RecipeError);
      }
    }
  });
});

describe("runRecipeSteps", () => {
  it("acceptance test 1 through the parser: byte-identical, expect block met", () => {
    const r = parseRecipe(SPEC_RECIPE);
    const { edid, steps } = runRecipeSteps(fixture("Tessera-EJE-test.txt").edid, r);
    const bytes = serializeEdid(edid);
    expect(Buffer.from(bytes).toString("hex")).toBe(Buffer.from(fixture("Tessera-EJE-4K50-10bit-RGB.txt").bytes).toString("hex"));
    expect(checkExpect(bytes, r.expect ?? {})).toEqual([]);
    expect(steps.map((s) => s.label)).toEqual(["keepOnlyModes", "setPreferredTiming 3840x2160 @ 50 Hz", "setColor rgb, 10-bit", "setRangeLimits 50-50 Hz, 110-113 kHz, 600 MHz"]);
    expect(steps[1]?.changes).toContain("Preferred timing: none → 3840x2160 @ 50.000 Hz (444.00 MHz)");
  });

  it("reports what an expect block finds wrong", () => {
    const { edid } = runRecipeSteps(fixture("Tessera-EJE-test.txt").edid, parseRecipe(SPEC_RECIPE));
    expect(checkExpect(serializeEdid(edid), { bytes: 384, dtd: "00 01", checksums: ["bf", "00"] })).toEqual([
      "expected 384 bytes, got 256",
      "expected the first descriptor to be 00 01, got 70 ad 00 a0 f0 70 3c 80 30 20 8a 00 00 00 00 00 00 1a",
      "expected block 1 checksum 00, got d6",
    ]);
  });

  it("runs every operation", () => {
    const r = parseRecipe(
      JSON.stringify({
        recipe: 1,
        ops: [
          { op: "keepOnlyModes", modes: [] },
          { op: "setPreferredTiming", width: 3840, height: 2160, refresh: "50", formula: "exact" },
          { op: "addMode", width: 1920, height: 1080, refresh: "60", formula: "vic" },
          { op: "addMode", width: 5760, height: 1080, refresh: "50", formula: "cvt-rb2" },
          { op: "removeMode", width: 1920, height: 1080, refresh: 60 },
          { op: "setColor", formats: ["rgb", "ycbcr444"], depths: [10] },
          { op: "setRangeLimits", auto: true },
          { op: "setIdentity", manufacturerId: "VYV", productCode: 2, name: "Wall C", year: 2026 },
          { op: "setHdmiCaps", maxTmdsMHz: 600, scdc: true, physicalAddress: "1.0.0.0" },
          { op: "setAudio", channels: 2, ratesKHz: [32, 44.1, 48], depths: [16, 24] },
          { op: "stripAudio" },
          { op: "setSerial", serial: 3 },
          { op: "setMonitorName", name: "Wall C-3" },
        ],
      }),
    );
    const { edid, steps } = runRecipeSteps(fixture("Tessera-EJE-test.txt").edid, r);
    expect(steps).toHaveLength(13);
    expect(displayIdTimings(edid).map((t) => t.hActive)).toEqual([5760]);
    expect(edid.base.serialNumber).toBe(3);
    expect(() => serializeEdid(edid)).not.toThrow();
    expect(steps.every((s) => s.changes.length > 0)).toBe(true);
  });

  it("names the step that failed", () => {
    const r = parseRecipe(JSON.stringify({ recipe: 1, ops: [{ op: "setMonitorName", name: "ok" }, { op: "removeMode", width: 1, height: 1, refresh: 60 }] }));
    expect(() => runRecipeSteps(fixture("Tessera-EJE-test.txt").edid, r)).toThrow("op 2 (removeMode): no 1x1 @ 60 Hz mode to remove");
  });
});
