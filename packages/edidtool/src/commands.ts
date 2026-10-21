// The edidtool commands (SPEC.md section 12). Each returns its exit code;
// failures throw CliError. Text goes to stdout, problems to stderr.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { env, stdout } from "node:process";
import {
  addDisplayIdTiming,
  autoRangeLimits,
  buildEdid,
  buildTiming,
  checkExpect,
  describeChanges,
  describeEdid,
  EdidEncodeError,
  EdidExportError,
  EdidParseError,
  exactDefaults,
  exportEdid,
  fallbackDtd,
  feasibility,
  FORMAT_NAMES,
  FORMULA_NAMES,
  keepOnlyModes,
  LINKS,
  parseRecipe,
  printable,
  runRecipeSteps,
  serializeEdid,
  setColor,
  setMonitorName,
  setPreferredTiming,
  setRangeLimits,
  validateBytes,
} from "@edid-studio/core";
import type { Edid, ExportFormat, ImportedEdid, Issue, Link, TimingResult } from "@edid-studio/core";
import { colours, depths, flag, formula, int, link, parse, positional, required, requiredInt, str } from "./args.ts";
import type { Parsed } from "./args.ts";
import { CliError, EXIT, hexStyleFor, readEdid, readLimited, shown, writeOutput } from "./io.ts";

const say = (lines: string | readonly string[]) => stdout.write(`${typeof lines === "string" ? lines : lines.join("\n")}\n`);
const json = (v: unknown) => stdout.write(`${JSON.stringify(v, null, 2)}\n`);
const mhz = (khz: number, digits = 2) => `${(khz / 1000).toFixed(digits)} MHz`;

/** Exit code for a set of issues: errors 2, warnings 1 (2 with --strict), else 0. */
function exitFor(issues: readonly Issue[], strict = false): number {
  if (issues.some((i) => i.severity === "error")) return EXIT.errors;
  if (issues.some((i) => i.severity === "warning")) return strict ? EXIT.errors : EXIT.warnings;
  return EXIT.clean;
}

function issueLines(issues: readonly Issue[]): string[] {
  return issues.flatMap((i) => [`${i.severity.padEnd(7)} ${i.rule}  ${i.message}`, ...(i.fix ? [`        fix: ${i.fix.label}`] : [])]);
}

/** Runs an encode step, turning "cannot encode" into exit 2 (nothing written). */
function encoding<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof EdidEncodeError || e instanceof EdidExportError) throw new CliError(EXIT.errors, e.message);
    if (e instanceof EdidParseError) throw new CliError(EXIT.usage, e.message);
    throw e;
  }
}

// ---------------------------------------------------------------------------

export function decode(args: readonly string[]): number {
  const p = parse(args, { json: { type: "boolean" } });
  const file = positional(p, 0, "the EDID file to decode");
  const input = readEdid(file);
  if (flag(p, "json")) {
    json({ file, format: input.format, bytes: input.bytes.length, checksumErrors: input.checksumErrors, edid: input.edid });
    return EXIT.clean;
  }
  say(describeEdid(input.edid));
  for (const c of input.checksumErrors) say(`Note: ${c} in the file; any export writes the correct value.`);
  return EXIT.clean;
}

export function validate(args: readonly string[]): number {
  const p = parse(args, { link: { type: "string" }, strict: { type: "boolean" }, "second-opinion": { type: "boolean" }, json: { type: "boolean" } });
  const file = positional(p, 0, "the EDID file to validate");
  const input = readEdid(file);
  const report = validateBytes(input.bytes, { link: link(p) });
  let code = exitFor(report.issues, flag(p, "strict"));
  const second = flag(p, "second-opinion") ? secondOpinion(input.bytes) : undefined;
  if (second && !second.pass && code === EXIT.clean) code = flag(p, "strict") ? EXIT.errors : EXIT.warnings;
  if (flag(p, "json")) {
    json({ file, errors: report.errors, warnings: report.warnings, issues: report.issues.map(({ fix, ...i }) => ({ ...i, ...(fix ? { fix: fix.label } : {}) })), ...(second ? { secondOpinion: second } : {}) });
    return code;
  }
  say(issueLines(report.issues));
  say(`${report.errors} error${report.errors === 1 ? "" : "s"}, ${report.warnings} warning${report.warnings === 1 ? "" : "s"} (${LINKS[link(p)].name})`);
  if (second) say(["", "edid-decode --check (second opinion):", ...(second.failures.length > 0 ? second.failures.map((f) => `  ${f}`) : ["  no failures"])]);
  return code;
}

/** Where `pnpm edid-decode` puts the pinned build. */
const CACHED_EDID_DECODE = fileURLToPath(new URL("../../../.cache/edid-decode/edid-decode", import.meta.url));

/**
 * Runs edid-decode --check on the bytes: EDID_DECODE, else the pinned build
 * in the repo cache, else edid-decode on the PATH. Its output is printed
 * through printable().
 */
function secondOpinion(bytes: Uint8Array): { pass: boolean; failures: string[] } {
  const bin = env["EDID_DECODE"] ?? (existsSync(CACHED_EDID_DECODE) ? CACHED_EDID_DECODE : "edid-decode");
  const r = spawnSync(bin, ["--check", "-"], { input: bytes, encoding: "utf8", timeout: 30_000 });
  if (r.error || r.status === null) throw new CliError(EXIT.usage, `edid-decode could not run (${shown(bin)}); install it or set EDID_DECODE (pnpm edid-decode builds the pinned version)`);
  const out = r.stdout;
  const section = out.split("\nFailures:\n")[1]?.split("\nEDID conformity")[0] ?? "";
  const failures = section
    .split("\n")
    .filter((l) => /^ {2}\S/.test(l) && !/^ {2}Block \d+|^ {2}EDID:$/.test(l))
    .map((l) => printable(l.trim(), 300));
  return { pass: /EDID conformity: PASS/.test(out), failures };
}

// ---------------------------------------------------------------------------

/** --hblank and --vblank-lines fix the totals; the porches default to CVT-RB v1 minimums. */
function timingFromArgs(p: Parsed, w: number, h: number, refresh: string): TimingResult {
  const f = formula(p);
  const hBlank = int(p, "hblank");
  const vBlank = int(p, "vblank-lines");
  const polarity = str(p, "polarity");
  if (polarity !== undefined && !/^H[+-]V[+-]$/.test(polarity)) throw new CliError(EXIT.usage, "--polarity must be like H+V-");
  const pol = polarity ? { hSyncPositive: polarity[1] === "+", vSyncPositive: polarity[3] === "+" } : {};
  const minHdmiHBlank = int(p, "min-hblank");
  const extra = { ...pol, ...(minHdmiHBlank !== undefined ? { minHdmiHBlank } : {}) };
  return encoding(() => {
    if (hBlank === undefined && vBlank === undefined) {
      if (f === "manual") throw new CliError(EXIT.usage, "--formula manual needs --hblank and --vblank-lines");
      return buildTiming({ hActive: w, vActive: h, refresh, formula: f, ...extra });
    }
    if (hBlank === undefined || vBlank === undefined) throw new CliError(EXIT.usage, "give --hblank and --vblank-lines together");
    if (f !== "exact" && f !== "manual") throw new CliError(EXIT.usage, "--hblank and --vblank-lines work with --formula exact or manual");
    const d = exactDefaults(w, h, refresh);
    const hfp = int(p, "hfp") ?? d.hFrontPorch;
    const hs = int(p, "hsync") ?? d.hSync;
    const vfp = int(p, "vfp") ?? d.vFrontPorch;
    const vs = int(p, "vsync") ?? d.vSync;
    return buildTiming({
      hActive: w,
      vActive: h,
      refresh,
      formula: "manual",
      porches: { hFrontPorch: hfp, hSync: hs, hBackPorch: hBlank - hfp - hs, vFrontPorch: vfp, vSync: vs, vBackPorch: vBlank - vfp - vs },
      ...extra,
    });
  });
}

const TIMING_OPTIONS = {
  width: { type: "string" },
  height: { type: "string" },
  refresh: { type: "string" },
  formula: { type: "string" },
  hblank: { type: "string" },
  "vblank-lines": { type: "string" },
  hfp: { type: "string" },
  hsync: { type: "string" },
  vfp: { type: "string" },
  vsync: { type: "string" },
  polarity: { type: "string" },
  "min-hblank": { type: "string" },
} as const;

export function timing(args: readonly string[]): number {
  const p = parse(args, { ...TIMING_OPTIONS, explain: { type: "boolean" }, json: { type: "boolean" }, link: { type: "string" } });
  const w = requiredInt(p, "width");
  const h = requiredInt(p, "height");
  const refresh = required(p, "refresh");
  const r = timingFromArgs(p, w, h, refresh);
  const fits = r.dtd !== undefined || r.displayId !== undefined;
  const code = !fits ? EXIT.errors : !r.exact || !r.dtd || r.notes.length > 0 ? EXIT.warnings : EXIT.clean;
  if (flag(p, "json")) {
    json(r);
    return code;
  }
  const t = r.timing;
  const yes = (v: boolean) => (v ? "yes" : "no");
  say([
    `${w}x${h} @ ${printable(refresh, 20)} Hz (${FORMULA_NAMES[r.request.formula]})`,
    `Total ${t.hTotal} x ${t.vTotal}, pixel clock ${mhz(t.pixelClock10kHz * 10, 3)}`,
    r.exact ? `Refresh ${r.achievedHz.toFixed(6)} Hz, exact (0 ppm)` : `Refresh ${r.achievedHz.toFixed(6)} Hz, ${r.errorPpm >= 0 ? "+" : ""}${r.errorPpm.toFixed(1)} ppm from ${r.targetHz.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")} Hz`,
    `H front/sync/back ${t.hFrontPorch}/${t.hSync}/${t.hBackPorch}, ${t.hSyncPositive ? "positive" : "negative"}; V ${t.vFrontPorch}/${t.vSync}/${t.vBackPorch}, ${t.vSyncPositive ? "positive" : "negative"}`,
    `Encodings: DTD ${yes(r.encodings.dtd)}; DisplayID ${yes(r.encodings.displayId)}; VIC ${r.encodings.vics.join(", ") || "none"}; DMT ${r.encodings.dmts.map((d) => `0x${d.toString(16).padStart(2, "0")}`).join(", ") || "none"}`,
  ]);
  if (flag(p, "explain")) {
    say([...r.dtdProblems.map((x) => `DTD: ${x}`), ...(r.dtd ? [] : r.displayIdProblems.map((x) => `DisplayID: ${x}`)), ...r.notes.map((n) => `Note: ${n}`)]);
    say(["", ...linkTable(t.pixelClock10kHz * 10, link(p))]);
  }
  return code;
}

function linkTable(clockKHz: number, l: Link): string[] {
  const rows = feasibility(clockKHz, l);
  const depthsShown = [8, 10, 12, 16] as const;
  const head = `${"".padEnd(13)}${depthsShown.map((d) => `${d}-bit`.padStart(12)).join("")}`;
  return [
    `${LINKS[l].name}, limit ${LINKS[l].limitLabel} (rates include blanking):`,
    head,
    ...(["rgb", "ycbcr444", "ycbcr422", "ycbcr420"] as const).map((f) =>
      `${FORMAT_NAMES[f].padEnd(13)}${depthsShown
        .map((d) => {
          const x = rows.find((y) => y.format === f && y.depth === d);
          if (!x || x.unsupported) return "-".padStart(12);
          return `${(x.rateKHz / 1000).toFixed(1)} ${x.fits ? "ok" : "no"}`.padStart(12);
        })
        .join("")}`,
    ),
  ];
}

export function budget(args: readonly string[]): number {
  const p = parse(args, { timing: { type: "string" }, formula: { type: "string" }, color: { type: "string" }, depth: { type: "string" }, link: { type: "string" }, json: { type: "boolean" } });
  const m = /^(\d+)x(\d+)@([\d./]+)$/.exec(required(p, "timing"));
  if (!m) throw new CliError(EXIT.usage, "--timing must look like 3840x2160@50");
  const [w, h, refresh] = [Number(m[1]), Number(m[2]), m[3] ?? ""];
  const [format] = colours(p, "rgb");
  const [depth] = depths(p, "8");
  if (format === undefined || depth === undefined) throw new CliError(EXIT.usage, "give one --color and one --depth");
  const l = link(p);
  const r = encoding(() => buildTiming({ hActive: w, vActive: h, refresh, formula: formula(p) }));
  const clock = r.timing.pixelClock10kHz * 10;
  const rows = feasibility(clock, l);
  const row = rows.find((x) => x.format === format && x.depth === depth);
  if (!row) throw new CliError(EXIT.usage, "no such format and depth");
  const fits = row.fits && !row.unsupported;
  if (flag(p, "json")) {
    json({ timing: r.timing, link: l, format, depth, rateKHz: row.rateKHz, fits, ...(row.unsupported ? { unsupported: row.unsupported } : {}) });
    return fits ? EXIT.clean : EXIT.errors;
  }
  const fitting = rows.filter((x) => x.fits && !x.unsupported).map((x) => `${x.depth}-bit ${FORMAT_NAMES[x.format]}`);
  say([
    `${w}x${h} @ ${refresh} Hz (${FORMULA_NAMES[r.request.formula]}): pixel clock ${mhz(clock)}`,
    row.unsupported
      ? `${depth}-bit ${FORMAT_NAMES[format]}: ${row.unsupported}`
      : `${depth}-bit ${FORMAT_NAMES[format]} needs ${mhz(row.rateKHz)}; ${LINKS[l].name} carries ${LINKS[l].limitLabel}: ${fits ? "fits" : "does not fit"}`,
    `Fits ${LINKS[l].name} at this clock: ${fitting.join(", ") || "nothing"}`,
  ]);
  return fits ? EXIT.clean : EXIT.errors;
}

// ---------------------------------------------------------------------------

/** Validates, then writes in the requested format. Errors: exit 2 and nothing written. */
function finish(edid: Edid, p: Parsed, source: ImportedEdid | undefined, issuesBefore: readonly string[] = []): number {
  const bytes = encoding(() => serializeEdid(edid));
  const report = validateBytes(bytes);
  const errors = report.issues.filter((i) => i.severity === "error");
  const out = str(p, "o");
  if (errors.length > 0) {
    say([...issuesBefore, ...issueLines(errors), "Nothing was written: fix the errors above first."]);
    return EXIT.errors;
  }
  const to = (str(p, "to") ?? "hex") as string;
  const formats: Record<string, ExportFormat> = { hex: "hex", bin: "binary", c: "c", base64: "base64" };
  const fmt = formats[to];
  if (fmt === undefined) throw new CliError(EXIT.usage, `--to must be hex, bin, c or base64`);
  const data = fmt === "hex" ? exportEdid(edid, "hex", hexStyleFor(str(p, "style"), source)) : exportEdid(edid, fmt);
  writeOutput(out, data, flag(p, "force"));
  const warnings = report.issues.filter((i) => i.severity === "warning");
  if (out !== undefined) say([...issuesBefore, ...issueLines(warnings), `Wrote ${shown(out)}: ${bytes.length} bytes, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}.`]);
  return warnings.length > 0 ? EXIT.warnings : EXIT.clean;
}

const OUTPUT_OPTIONS = { o: { type: "string" }, force: { type: "boolean" }, to: { type: "string" }, style: { type: "string" } } as const;

export function build(args: readonly string[]): number {
  const p = parse(args, {
    ...TIMING_OPTIONS,
    ...OUTPUT_OPTIONS,
    base: { type: "string" },
    color: { type: "string" },
    depth: { type: "string" },
    link: { type: "string" },
    name: { type: "string" },
    manufacturer: { type: "string" },
    product: { type: "string" },
    "with-640x480": { type: "boolean" },
  });
  const w = requiredInt(p, "width");
  const h = requiredInt(p, "height");
  const refresh = required(p, "refresh");
  const r = timingFromArgs(p, w, h, refresh);
  if (!r.dtd && !r.displayId) throw new CliError(EXIT.errors, `${w}x${h} fits neither a DTD nor DisplayID: ${[...r.dtdProblems, ...r.displayIdProblems].join("; ")}`);
  const formats = colours(p, "rgb");
  const ds = depths(p, "8");
  const basePath = str(p, "base");
  const name = str(p, "name");

  if (basePath !== undefined) {
    const base = readEdid(basePath);
    const edid = encoding(() => {
      let e = keepOnlyModes(base.edid);
      if (r.dtd) e = setPreferredTiming(e, r.dtd);
      else if (r.displayId) e = addDisplayIdTiming(setPreferredTiming(e, fallbackDtd(refresh)), r.displayId);
      e = setColor(e, formats, ds);
      const limits = autoRangeLimits(e, e.base.revision >= 4 ? "none" : "default");
      if (limits) e = setRangeLimits(e, limits);
      return name !== undefined ? setMonitorName(e, name) : e;
    });
    return finish(edid, p, base);
  }

  const edid = encoding(() =>
    buildEdid({
      name: name ?? "EDID Studio",
      manufacturerId: str(p, "manufacturer") ?? "VYV",
      productCode: int(p, "product") ?? 1,
      year: new Date().getFullYear(),
      timing: r.dtd ?? fallbackDtd(refresh),
      ...(r.dtd || !r.displayId ? {} : { displayIdTimings: [r.displayId] }),
      link: link(p),
      formats,
      depths: ds,
      include640x480: flag(p, "with-640x480"),
    }),
  );
  return finish(edid, p, undefined);
}

export function recipeRun(args: readonly string[]): number {
  const p = parse(args, { ...OUTPUT_OPTIONS, base: { type: "string" }, json: { type: "boolean" } });
  const file = positional(p, 0, "the recipe file");
  const recipe = encoding(() => parseRecipe(readLimited(file).toString("utf8")));
  let basePath = str(p, "base");
  if (basePath === undefined) {
    if (!recipe.base) throw new CliError(EXIT.usage, "the recipe names no base file; add --base <file>");
    // A recipe is untrusted: its base must stay inside the recipe's folder.
    const dir = dirname(resolve(file));
    basePath = resolve(dir, recipe.base.file);
    const rel = relative(dir, basePath);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new CliError(EXIT.usage, `base file ${shown(recipe.base.file)} is outside the recipe's folder; pass it with --base instead`);
  }
  const base = readEdid(basePath);
  const { edid, steps } = encoding(() => runRecipeSteps(base.edid, recipe));
  const lines = steps.flatMap((s, i) => [`${i + 1}. ${s.label}`, ...(s.changes.length > 0 ? s.changes.map((c) => `   ${c}`) : ["   (no change)"])]);
  if (recipe.expect) {
    const failed = checkExpect(encoding(() => serializeEdid(edid)), recipe.expect);
    if (failed.length > 0) {
      say([...lines, "Expect: FAILED", ...failed.map((f) => `  ${f}`), "Nothing was written."]);
      return EXIT.errors;
    }
    lines.push("Expect: all checks pass");
  }
  if (str(p, "o") === undefined) {
    say([...lines, "No output file given (-o); nothing was written."]);
    return exitFor(validateBytes(serializeEdid(edid)).issues);
  }
  return finish(edid, p, base, lines);
}

export function diff(args: readonly string[]): number {
  const p = parse(args, { json: { type: "boolean" } });
  const a = readEdid(positional(p, 0, "the first EDID file"));
  const b = readEdid(positional(p, 1, "the second EDID file"));
  const changes = describeChanges(a.edid, b.edid);
  const n = Math.max(a.bytes.length, b.bytes.length);
  let differ = 0;
  for (let i = 0; i < n; i++) if (a.bytes[i] !== b.bytes[i]) differ++;
  if (flag(p, "json")) json({ changes, bytesDiffer: differ });
  else say(differ === 0 ? "No differences." : [...changes, `${differ} bytes differ.`]);
  return differ === 0 ? EXIT.clean : EXIT.warnings;
}

export function convert(args: readonly string[]): number {
  const p = parse(args, OUTPUT_OPTIONS);
  const input = readEdid(positional(p, 0, "the EDID file to convert"));
  const to = required(p, "to");
  if (to === "reg") {
    throw new CliError(EXIT.usage, "--to reg is not supported yet: a Windows .reg override needs the display's registry key (TODO(verify) against Microsoft's EDID override documentation)");
  }
  const formats: Record<string, ExportFormat> = { hex: "hex", bin: "binary", c: "c", base64: "base64" };
  const fmt = formats[to];
  if (fmt === undefined) throw new CliError(EXIT.usage, "--to must be hex, bin, c, base64 or reg");
  if (fmt === "binary" && str(p, "o") === undefined) throw new CliError(EXIT.usage, "binary output needs a file: add -o <file>");
  const data = encoding(() => (fmt === "hex" ? exportEdid(input.edid, "hex", hexStyleFor(str(p, "style"), input)) : exportEdid(input.edid, fmt)));
  writeOutput(str(p, "o"), data, flag(p, "force"));
  if (input.checksumErrors.length > 0) {
    process.stderr.write(`${input.checksumErrors.map((c) => `Note: ${c} in the input; the output has the correct value.`).join("\n")}\n`);
    return EXIT.warnings;
  }
  return EXIT.clean;
}
