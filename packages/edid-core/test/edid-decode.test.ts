// Independent second opinion (SPEC.md section 8). Runs only when EDID_DECODE
// points at an edid-decode binary (CI builds one with
// scripts/build-edid-decode.sh). Arguments are passed as an array, never a
// shell string.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { importEdid, validateBytes } from "../src/index.ts";
import type { RuleId } from "../src/index.ts";
import { CORPUS_DIR, FIXTURES_DIR } from "./corpus.ts";
import { GOLDEN } from "./golden.ts";

const bin = process.env["EDID_DECODE"];
const work = mkdtempSync(join(tmpdir(), "edid-studio-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function decode(bytes: Uint8Array): { failures: string[]; output: string } {
  const file = join(work, "edid.bin");
  writeFileSync(file, bytes);
  let output: string;
  try {
    output = execFileSync(bin ?? "", ["--check", file], { encoding: "utf8" });
  } catch (e) {
    // edid-decode exits non-zero when conformity fails; the report is still on stdout.
    output = String((e as { stdout?: unknown }).stdout ?? "");
  }
  const section = output.split("\nFailures:\n")[1]?.split("\nEDID conformity")[0] ?? "";
  const failures = section
    .split("\n")
    .filter((l) => /^ {2}\S/.test(l) && !/^ {2}Block \d+|^ {2}EDID:$/.test(l))
    .map((l) => l.trim().replace(/^.*?: (?=[A-Z'])/, ""));
  return { failures, output };
}

describe.skipIf(!bin)("acceptance test 7: edid-decode --check on every golden output", () => {
  for (const g of GOLDEN) {
    it(g.name, () => {
      const { failures, output } = decode(g.bytes());
      expect(failures.sort(), output).toEqual([...g.expectFailures].sort());
    });
  }
});

/** Our rule versus the edid-decode message it mirrors. */
const MIRRORS: Partial<Record<RuleId, RegExp>> = {
  "base.srgb": /chromaticities match sRGB, but sRGB is not signaled|sRGB is signaled, but the chromaticities do not match/,
  "range.class": /is not allowed for EDID < 1\.4|Unknown range class/,
  "cta.640x480": /Required 640x480p60 timings are missing/,
  "hdmi.vsdb-tmds": /HDMI VSDB Max TMDS rate is > 340/,
  "svd.unknown-vic": /Unknown VIC \d+/,
  "svd.duplicate": /Duplicate VIC/,
  "y420.map-length": /Max index \d+ > \d+ \(#SVDs\)/,
  "std.unused-code": /Use 0x0101 as the invalid/,
  "descriptor.all-zero": /Use Dummy Descriptor instead of all zeroes/,
  "descriptor.dummy-garbage": /Dummy block filled with garbage/,
  "hdmi.edid-version": /HDMI Specification requires EDID 1\.3/,
  "hdmi.vic-equivalents": /HDMI VIC Codes must have their CTA-861 VIC equivalents/,
  "base.range-limits-missing": /Missing Display Range Limits Descriptor/,
  "range.covers-timings": /out of range of the Monitor Ranges/,
  "cta.byte3-consistent": /Byte 3 must be the same/,
};

/**
 * Known disagreements, each traced to something the model keeps raw and so
 * does not check. Anything not listed here is a bug to triage, never to
 * suppress (SPEC.md section 8).
 */
const KNOWN: Record<string, readonly RuleId[]> = {
  "acer-xv273k-dp2-corrupted": ["hdmi.vsdb-tmds", "svd.duplicate", "hdmi.edid-version"], // corrupted CTA blocks are kept raw
  "acer-xv273k-corrected_difdb": ["range.covers-timings"], // the fastest timing is in a DisplayID block
  "dell-up2715k-dp-switchresx": ["range.covers-timings"], // the fastest timing is in a DisplayID block
  "sharp-pn465-dvi": ["range.covers-timings"], // a 50 Hz timing is in a CTA revision 1 block
};

describe.skipIf(!bin)("validator agrees with edid-decode on the corpus", () => {
  const files = [
    ...readdirSync(join(CORPUS_DIR, "edid-decode")).filter((f) => f !== "LICENSE").map((f) => ({ name: f, bytes: new Uint8Array(readFileSync(join(CORPUS_DIR, "edid-decode", f))) })),
    ...readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".txt")).map((f) => ({ name: f, bytes: importEdid(readFileSync(join(FIXTURES_DIR, f), "utf8")).bytes })),
  ];
  for (const f of files) {
    it(f.name, () => {
      const { output } = decode(f.bytes);
      const ours = new Set(validateBytes(f.bytes).issues.map((i) => i.rule));
      const disagree = Object.entries(MIRRORS)
        .filter(([rule, re]) => ours.has(rule as RuleId) !== re.test(output))
        .map(([rule]) => rule)
        .sort();
      expect(disagree).toEqual([...(KNOWN[f.name] ?? [])].sort());
    });
  }
});
