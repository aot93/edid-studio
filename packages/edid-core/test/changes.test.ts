// Plain-language diff between two models (SPEC.md section 9: "each
// operation ... returns a plain-language diff").

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeChanges, importEdid, runRecipe, setHdmiCaps, setIdentity } from "../src/index.ts";
import type { Recipe } from "../src/index.ts";
import { FIXTURES_DIR } from "./corpus.ts";

const fixture = (name: string) => importEdid(readFileSync(join(FIXTURES_DIR, name), "utf8")).edid;

describe("describeChanges", () => {
  it("says nothing changed for the same model", () => {
    const e = fixture("Tessera-EJE-test.txt");
    expect(describeChanges(e, e)).toEqual([]);
  });

  it("explains the Tessera fix in plain language", () => {
    const before = fixture("Tessera-EJE-test.txt");
    const after = fixture("Tessera-EJE-4K50-10bit-RGB.txt");
    const lines = describeChanges(before, after);
    expect(lines).toContain("Preferred timing: 3840x2160 @ 60.000 Hz (594.00 MHz) → 3840x2160 @ 50.000 Hz (444.00 MHz)");
    expect(lines).toContain("Removed VIC 97 (3840x2160 @ 60.000 Hz)");
    expect(lines).toContain("YCbCr 4:4:4: yes → no");
    expect(lines).toContain("HDMI deep colour: 10, 12-bit → 10-bit");
    expect(lines.some((l) => l.startsWith("Range limits:"))).toBe(true);
    expect(lines).toContain("Removed YCbCr 4:2:0 capability map");
  });

  it("names identity and HDMI changes", () => {
    const e = fixture("Tessera-EJE-4K50-10bit-RGB.txt");
    const lines = describeChanges(e, setHdmiCaps(setIdentity(e, { productCode: 7, name: "Wall B" }), { physicalAddress: "2.0.0.0" }));
    expect(lines.some((l) => /^Product code: 0x[0-9a-f]{4} → 0x0007$/.test(l))).toBe(true);
    expect(lines.some((l) => /^Monitor name: ".*" → "Wall B"$/.test(l))).toBe(true);
    expect(lines.some((l) => /^HDMI physical address: .* → 2\.0\.0\.0$/.test(l))).toBe(true);
  });

  it("escapes EDID text it quotes", () => {
    const e = fixture("Tessera-EJE-4K50-10bit-RGB.txt");
    const odd = { ...e, base: { ...e.base, descriptors: e.base.descriptors.map((d) => (d.kind === "text" && d.tag === 0xfc ? { ...d, text: "A\u001bB" } : d)) } };
    expect(describeChanges(e, odd).join(" ")).toContain("A\\x1bB");
  });

  it("a recipe's steps each describe what they did", () => {
    const r: Recipe = { recipe: 1, ops: [{ op: "setMonitorName", name: "X" }] };
    const e = fixture("Tessera-EJE-test.txt");
    expect(describeChanges(e, runRecipe(e, r))).toEqual([`Monitor name: "${(e.base.descriptors.find((d) => d.kind === "text" && d.tag === 0xfc) as { text: string }).text}" → "X"`]);
  });
});
