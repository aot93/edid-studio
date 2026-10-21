#!/usr/bin/env node
// edidtool entry point (SPEC.md section 12). Exit codes: 0 clean, 1 warnings
// only, 2 errors found (nothing written), 3 usage or I/O error.

import { argv, exit, stderr, stdout } from "node:process";
import { printable } from "@edid-studio/core";
import { budget, build, convert, decode, diff, recipeRun, timing, validate } from "./commands.ts";
import { CliError, EXIT } from "./io.ts";

const USAGE = `edidtool: build, edit, validate and explain EDIDs

  edidtool decode   <file> [--json]
  edidtool validate <file> [--link dp1.4] [--strict] [--second-opinion] [--json]
  edidtool timing   --width 3840 --height 2160 --refresh 50 [--formula exact]
                    [--hblank 160 --vblank-lines 60] [--hfp --hsync --vfp --vsync]
                    [--polarity H+V-] [--min-hblank 160] [--explain] [--json]
  edidtool budget   --timing 3840x2160@50 [--formula cvt-rb] [--color rgb] [--depth 10] [--link hdmi2.0]
  edidtool build    [--base original.txt] --width 3840 --height 2160 --refresh 50
                    [--color rgb,ycbcr444] [--depth 10] [--link hdmi2.0] [--name "LED wall"]
                    [--manufacturer VYV] [--product 1] [--with-640x480] -o out.txt
  edidtool recipe run recipe.json [--base original.txt] -o out.txt
  edidtool diff     a.txt b.txt [--json]
  edidtool convert  in.txt --to hex|bin|c|base64 [-o out]

Formulas: exact, cvt, cvt-rb, cvt-rb2, cvt-rb3, gtf, vic, dmt, manual.
Links: dvi, hdmi1.4, hdmi2.0, hdmi2.1, dp1.2, dp1.4, dp2.1-uhbr10, dp2.1-uhbr13.5,
dp2.1-uhbr20. validate defaults to the EDID's own link. Outputs (-o) are never
replaced without --force.
Hex output mirrors the input's layout, or is one line; --style one-line|lines.
Exit codes: 0 clean, 1 warnings, 2 errors (nothing written), 3 usage or I/O.
`;

const COMMANDS: Record<string, (args: readonly string[]) => number> = { decode, validate, timing, budget, build, diff, convert };

function main(args: readonly string[]): number {
  const [command, ...rest] = args;
  if (command === undefined || command === "--help" || command === "-h" || rest.includes("--help")) {
    stdout.write(USAGE);
    return command === undefined ? EXIT.usage : EXIT.clean;
  }
  if (command === "recipe") {
    const [sub, ...recipeArgs] = rest;
    if (sub !== "run") throw new CliError(EXIT.usage, `unknown recipe command ${printable(sub ?? "", 20)}; use "recipe run"`);
    return recipeRun(recipeArgs);
  }
  const run = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!run) throw new CliError(EXIT.usage, `unknown command "${printable(command, 20)}"; see edidtool --help`);
  return run(rest);
}

// `pnpm cli -- <args>` passes the "--" through.
const args = argv.slice(2);
try {
  exit(main(args[0] === "--" ? args.slice(1) : args));
} catch (e) {
  if (e instanceof CliError) {
    stderr.write(`edidtool: ${e.message}\n`);
    exit(e.code);
  }
  stderr.write(`edidtool: internal error: ${printable(String(e), 300)}\n`);
  exit(EXIT.usage);
}
