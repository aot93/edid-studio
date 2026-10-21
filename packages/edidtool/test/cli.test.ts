// edidtool, end to end (SPEC.md section 12): every command run as a child
// process, with its output and exit code (0 clean, 1 warnings, 2 errors and
// nothing written, 3 usage or I/O).

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { importEdid } from "@edid-studio/core";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CLI = join(ROOT, "packages/edidtool/src/cli.ts");
const FIX = join(ROOT, "tests/fixtures");
const ORIGINAL = join(FIX, "Tessera-EJE-test.txt");
const WORKING = join(FIX, "Tessera-EJE-4K50-10bit-RGB.txt");
const work = mkdtempSync(join(tmpdir(), "edidtool-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function run(args: string[], env: Record<string, string | undefined> = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: work, env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const tmp = (name: string) => join(work, name);
const bytesOf = (file: string) => importEdid(readFileSync(file)).bytes;

describe("edidtool", () => {
  it("prints usage with --help and refuses an unknown command with exit 3", () => {
    const help = run(["--help"]);
    expect(help.code).toBe(0);
    for (const c of ["decode", "validate", "timing", "budget", "build", "recipe run", "diff", "convert"]) expect(help.out).toContain(c);
    expect(run(["frobnicate"]).code).toBe(3);
    expect(run(["timing", "--bogus"]).code).toBe(3);
  });
});

describe("decode", () => {
  it("describes an EDID in plain text, or as JSON", () => {
    const r = run(["decode", ORIGINAL]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Preferred timing: 3840x2160 @ 60.000 Hz, 594.00 MHz");
    const j = JSON.parse(run(["decode", ORIGINAL, "--json"]).out) as { bytes: number; edid: { base: { version: number } } };
    expect([j.bytes, j.edid.base.version]).toEqual([256, 1]);
  });

  it("exits 3 for a missing file or one that is not an EDID, without echoing it", () => {
    expect(run(["decode", tmp("nope.txt")]).code).toBe(3);
    writeFileSync(tmp("evil.txt"), "<script>\u001b[2J</script>");
    const r = run(["decode", tmp("evil.txt")]);
    expect(r.code).toBe(3);
    expect(r.err).not.toContain("\u001b");
  });
});

describe("validate", () => {
  it("acceptance test 2: explains the 10-bit failure on the original (warnings, exit 1)", () => {
    const r = run(["validate", ORIGINAL]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("link.too-fast");
    expect(r.out).toContain("10-bit RGB needs 742.50 MHz");
    expect(r.out).toMatch(/fits as YCbCr 4:2:2 \(594\.00 MHz\) or YCbCr 4:2:0 \(371\.25 MHz\)/);
  });

  it("--strict turns warnings into a failure; a bad checksum is an error", () => {
    expect(run(["validate", WORKING, "--strict"]).code).toBe(2);
    const bytes = Uint8Array.from(bytesOf(WORKING));
    bytes[127] = (bytes[127] ?? 0) ^ 1;
    writeFileSync(tmp("bad.bin"), bytes);
    const r = run(["validate", tmp("bad.bin")]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("structure.checksum");
  });

  it("--second-opinion runs edid-decode when it is there, and says so when it is not", () => {
    const missing = run(["validate", WORKING, "--second-opinion"], { EDID_DECODE: tmp("no-such-binary") });
    expect(missing.code).toBe(3);
    expect(missing.err).toMatch(/edid-decode/);
    const bin = process.env["EDID_DECODE"];
    if (!bin) return;
    const r = run(["validate", WORKING, "--second-opinion"], { EDID_DECODE: bin });
    expect(r.out).toContain("edid-decode --check");
    expect(r.out).toContain("sRGB is not signaled");
  });
});

describe("timing", () => {
  it("acceptance test 3: 160-pixel and 60-line blanking for 3840x2160 at 50 Hz is exact", () => {
    const r = run(["timing", "--width", "3840", "--height", "2160", "--refresh", "50", "--formula", "exact", "--hblank", "160", "--vblank-lines", "60", "--explain"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Total 4000 x 2220");
    expect(r.out).toContain("444.000 MHz");
    expect(r.out).toContain("50.000000 Hz, exact (0 ppm)");
  });

  it("acceptance test 4: VIC 96 does not fit a DTD, names the field, offers the VIC and reduced blanking", () => {
    const r = run(["timing", "--width", "3840", "--height", "2160", "--refresh", "50", "--formula", "vic", "--explain"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("horizontal front porch 1056 exceeds 1023");
    expect(r.out).toContain("VIC 96");
    expect(r.out).toMatch(/reduced blanking/);
  });

  it("acceptance test 9: 59.94 Hz reports its ppm error and is never called exact", () => {
    const r = run(["timing", "--width", "1920", "--height", "1080", "--refresh", "59.94", "--formula", "cvt-rb"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/ppm from 59\.94/);
    expect(r.out).not.toMatch(/exact \(0 ppm\)/);
  });

  it("prints JSON, and exits 2 for a raster nothing can hold", () => {
    const j = JSON.parse(run(["timing", "--width", "1920", "--height", "1080", "--refresh", "60", "--formula", "dmt", "--json"]).out) as { timing: { pixelClock10kHz: number } };
    expect(j.timing.pixelClock10kHz).toBe(14850);
    expect(run(["timing", "--width", "70000", "--height", "10", "--refresh", "60"]).code).toBe(2);
  });
});

describe("budget", () => {
  it("says whether a format and depth fit the link, exit 2 when not", () => {
    const no = run(["budget", "--timing", "3840x2160@60", "--formula", "vic", "--color", "rgb", "--depth", "10", "--link", "hdmi2.0"]);
    expect(no.code).toBe(2);
    expect(no.out).toContain("742.50 MHz");
    expect(no.out).toMatch(/does not fit/);
    const yes = run(["budget", "--timing", "3840x2160@60", "--formula", "vic", "--color", "ycbcr422", "--depth", "10"]);
    expect(yes.code).toBe(0);
    expect(yes.out).toMatch(/fits/);
  });
});

describe("DisplayPort and HDMI 2.1", () => {
  it("budget speaks Gbps on DisplayPort and FRL on HDMI 2.1", () => {
    const dp = run(["budget", "--timing", "3840x2160@144", "--formula", "cvt-rb2", "--color", "rgb", "--depth", "10", "--link", "dp1.4"]);
    expect(dp.code).toBe(2);
    expect(dp.out).toMatch(/10-bit RGB needs 39\.\d\d Gbps; DisplayPort 1\.4 \(HBR3\) carries 25\.92 Gbps: does not fit/);
    const frl = run(["budget", "--timing", "3840x2160@120", "--formula", "vic", "--color", "rgb", "--depth", "10", "--link", "hdmi2.1"]);
    expect(frl.code).toBe(0);
    // VIC 117 has 560 pixels of horizontal blanking, which FRL partly compresses: 33.70 Gbps, so FRL 10 Gbps x 4 (the familiar "40 Gbps for 4K120 10-bit").
    expect(frl.out).toContain("needs 33.70 Gbps");
    expect(frl.out).toContain("fits over FRL 10 Gbps x 4");
  });

  it("builds a DisplayPort EDID that validates against its own link by default", () => {
    const out = tmp("dp.txt");
    expect(run(["build", "--width", "3840", "--height", "2160", "--refresh", "60", "--formula", "cvt-rb2", "--depth", "10", "--link", "dp1.4", "-o", out]).code).toBe(0);
    const v = run(["validate", out]);
    expect(v.code).toBe(0);
    expect(v.out).toContain("(DisplayPort 1.4 (HBR3))");
  });
});

describe("build", () => {
  it("builds a 5760x1080 LED wall EDID from scratch, and never overwrites without --force", () => {
    const out = tmp("wall.txt");
    const args = ["build", "--width", "5760", "--height", "1080", "--refresh", "60", "--color", "rgb", "--depth", "10", "--link", "hdmi2.0", "--name", "Wall A", "-o", out];
    const r = run(args);
    expect(r.code).toBe(0);
    expect(bytesOf(out).length).toBe(384);
    writeFileSync(out, "keep me");
    expect(run(args).code).toBe(3);
    expect(readFileSync(out, "utf8")).toBe("keep me");
    expect(run([...args, "--force"]).code).toBe(0);
  });

  it("rebuilds from a base EDID in the base file's hex layout", () => {
    const out = tmp("from-base.txt");
    const r = run(["build", "--base", ORIGINAL, "--width", "3840", "--height", "2160", "--refresh", "50", "--color", "rgb", "--depth", "10", "-o", out]);
    expect(r.code).toBeLessThan(2);
    const { edid } = importEdid(readFileSync(out, "utf8"));
    const d = edid.base.descriptors[0];
    if (d?.kind !== "dtd") throw new Error("no preferred DTD");
    expect([d.hActive, d.vActive]).toEqual([3840, 2160]);
    // The exact formula: exactly 50 Hz from a whole number of 10 kHz steps.
    expect(d.pixelClock10kHz * 10_000).toBe((d.hActive + d.hBlank) * (d.vActive + d.vBlank) * 50);
    // The Tessera .txt is one line of bytes; the output mirrors it.
    expect(readFileSync(out, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("refuses what cannot be built, writing nothing (exit 2)", () => {
    const out = tmp("never.txt");
    expect(run(["build", "--width", "3840", "--height", "2160", "--refresh", "60", "--formula", "vic", "--depth", "10", "--link", "hdmi1.4", "-o", out]).code).toBe(2);
    expect(existsSync(out)).toBe(false);
  });
});

describe("recipe run", () => {
  const recipeFile = tmp("fix.json");
  const spec = {
    recipe: 1,
    base: { file: "Tessera-EJE-test.txt" },
    ops: [
      { op: "keepOnlyModes", modes: [] },
      { op: "setPreferredTiming", width: 3840, height: 2160, refresh: "50", formula: "exact-refresh", hBlank: 160, vBlankLines: 60, hFrontPorch: 48, hSync: 32, vFrontPorch: 8, vSync: 10, polarity: "H+V-" },
      { op: "setColor", formats: ["rgb"], depths: [10] },
      { op: "setRangeLimits", vHz: [50, 50], hKHz: [110, 113], maxClockMHz: 600, gtf: "none" },
    ],
    expect: { bytes: 256, dtd: "70 ad 00 a0 f0 70 3c 80 30 20 8a 00 00 00 00 00 00 1a", checksums: ["bf", "d6"] },
  };

  it("acceptance test 1 from the command line: byte-identical to the working file", () => {
    copyFileSync(ORIGINAL, tmp("Tessera-EJE-test.txt"));
    writeFileSync(recipeFile, JSON.stringify(spec));
    const out = tmp("fixed.txt");
    const r = run(["recipe", "run", recipeFile, "-o", out]);
    expect(r.code).toBe(1); // the two warnings NVIDIA accepted
    expect(r.out).toContain("2. setPreferredTiming 3840x2160 @ 50 Hz");
    expect(r.out).toContain("Expect: all checks pass");
    expect(Buffer.from(bytesOf(out)).toString("hex")).toBe(Buffer.from(bytesOf(WORKING)).toString("hex"));
  });

  it("an unmet expect block fails and writes nothing", () => {
    writeFileSync(tmp("bad-expect.json"), JSON.stringify({ ...spec, expect: { bytes: 384 } }));
    const out = tmp("not-written.txt");
    const r = run(["recipe", "run", tmp("bad-expect.json"), "-o", out]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("expected 384 bytes, got 256");
    expect(existsSync(out)).toBe(false);
  });

  it("refuses a base file outside the recipe's folder, and a malformed recipe", () => {
    writeFileSync(tmp("escape.json"), JSON.stringify({ ...spec, base: { file: "../outside.txt" } }));
    const r = run(["recipe", "run", tmp("escape.json")]);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/outside the recipe's folder/);
    writeFileSync(tmp("broken.json"), "{");
    expect(run(["recipe", "run", tmp("broken.json")]).code).toBe(3);
  });
});

describe("diff", () => {
  it("lists the changes in plain language (exit 1), or none (exit 0)", () => {
    const r = run(["diff", ORIGINAL, WORKING]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Removed VIC 97 (3840x2160 @ 60.000 Hz)");
    expect(r.out).toMatch(/\d+ bytes differ/);
    expect(run(["diff", ORIGINAL, ORIGINAL]).code).toBe(0);
  });
});

describe("convert", () => {
  it.each([
    ["base64", (s: string) => s.startsWith("AP///////wA")],
    ["c", (s: string) => s.startsWith("unsigned char edid[256]")],
    ["hex", (s: string) => s.startsWith("00 ff ff ff")],
  ] as const)("--to %s round-trips", (to, looks) => {
    const out = tmp(`conv.${to}`);
    expect(run(["convert", WORKING, "--to", to, "-o", out]).code).toBe(0);
    expect(looks(readFileSync(out, "utf8"))).toBe(true);
    expect(bytesOf(out)).toEqual(bytesOf(WORKING));
  });

  it("writes binary only to a file, and has no .reg output (the app never writes to a machine)", () => {
    expect(run(["convert", WORKING, "--to", "bin"]).code).toBe(3);
    expect(run(["convert", WORKING, "--to", "bin", "-o", tmp("w.bin")]).code).toBe(0);
    expect(readFileSync(tmp("w.bin"))).toEqual(Buffer.from(bytesOf(WORKING)));
    const reg = run(["convert", WORKING, "--to", "reg"]);
    expect(reg.code).toBe(3);
    expect(reg.err).toMatch(/--to must be hex, bin, c or base64/);
  });
});
