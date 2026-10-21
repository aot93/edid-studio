// The text report behind `edidtool decode` (SPEC.md section 12).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEdid, buildTiming, describeEdid, importEdid } from "../src/index.ts";
import { CORPUS_DIR, FIXTURES_DIR } from "./corpus.ts";

const fixture = (name: string) => importEdid(readFileSync(join(FIXTURES_DIR, name), "utf8")).edid;

describe("describeEdid", () => {
  it("summarises the working Tessera EDID", () => {
    const text = describeEdid(fixture("Tessera-EJE-4K50-10bit-RGB.txt")).join("\n");
    expect(text).toContain("EDID 1.3, 256 bytes: base block, CTA-861");
    expect(text).toMatch(/Preferred timing: 3840x2160 @ 50\.000 Hz, 444\.00 MHz, total 4000 x 2220/);
    expect(text).toContain("H front/sync/back 48/32/80, positive; V 8/10/42, negative");
    expect(text).toContain("Range limits: 50-50 Hz, 110-113 kHz, 600 MHz");
    expect(text).toContain("Colour: RGB; deep colour 10-bit");
    expect(text).toMatch(/HDMI VSDB: physical address \d\.\d\.\d\.\d, max TMDS \d+ MHz/);
  });

  it("lists DisplayID timings", () => {
    const wide = buildTiming({ hActive: 5760, vActive: 1080, refresh: "60", formula: "exact" });
    const fb = buildTiming({ hActive: 1920, vActive: 1080, refresh: "60", formula: "exact" }).dtd;
    if (!wide.displayId || !fb) throw new Error("timing");
    const e = buildEdid({ name: "W", manufacturerId: "VYV", productCode: 1, year: 2026, timing: fb, displayIdTimings: [wide.displayId], link: "hdmi2.0", formats: ["rgb"], depths: [8] });
    const text = describeEdid(e).join("\n");
    expect(text).toContain("EDID 1.3, 384 bytes: base block, CTA-861, DisplayID 1.2");
    expect(text).toMatch(/Preferred timing: 5760x1080 @ 60\.000 Hz, .* \(DisplayID\)/);
    expect(text).toContain("DisplayID timing 5760x1080 @ 60.000 Hz");
  });

  it("escapes EDID text and never fails on a corpus EDID", () => {
    for (const f of ["dell-p2415q-hdmi2.0", "samsung-q800t-hdmi2.1", "apple-xdr-6k", "sharp-pn465-dvi"]) {
      const lines = describeEdid(importEdid(new Uint8Array(readFileSync(join(CORPUS_DIR, "edid-decode", f)))).edid);
      expect(lines.length).toBeGreaterThan(5);
      expect(lines.join("\n")).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
    }
  });
});
