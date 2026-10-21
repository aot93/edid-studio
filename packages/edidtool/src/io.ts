// File and terminal I/O for edidtool. Input files are untrusted (SPEC.md
// section 13): size is checked before reading, parsing goes through
// importEdid, and anything quoted back is passed through printable().

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { stdout } from "node:process";
import { DEFAULT_HEX_STYLE, EdidParseError, importEdid, MAX_INPUT_BYTES, ONE_LINE_HEX_STYLE, printable } from "@edid-studio/core";
import type { HexStyle, ImportedEdid } from "@edid-studio/core";

/** Exit codes (SPEC.md section 12). */
export const EXIT = { clean: 0, warnings: 1, errors: 2, usage: 3 } as const;

/** A failure with its exit code and a message for stderr. */
export class CliError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export const shown = (path: string) => printable(path, 200);

/** Reads a file of at most MAX_INPUT_BYTES. */
export function readLimited(path: string): Buffer {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new CliError(EXIT.usage, `${shown(path)}: cannot read the file`);
  }
  if (size > MAX_INPUT_BYTES) throw new CliError(EXIT.usage, `${shown(path)}: ${size} bytes; the limit is ${MAX_INPUT_BYTES}`);
  try {
    return readFileSync(path);
  } catch {
    throw new CliError(EXIT.usage, `${shown(path)}: cannot read the file`);
  }
}

export function readEdid(path: string): ImportedEdid {
  const data = readLimited(path);
  try {
    return importEdid(new Uint8Array(data));
  } catch (e) {
    if (e instanceof EdidParseError) throw new CliError(EXIT.usage, `${shown(path)}: ${e.message}`);
    throw e;
  }
}

/** Writes to a file, refusing to replace one unless `force`; text without a path goes to stdout. */
export function writeOutput(path: string | undefined, data: string | Uint8Array, force: boolean): void {
  if (path === undefined) {
    if (typeof data !== "string") throw new CliError(EXIT.usage, "binary output needs a file: add -o <file>");
    stdout.write(data);
    return;
  }
  try {
    writeFileSync(path, data, { flag: force ? "w" : "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new CliError(EXIT.usage, `${shown(path)} exists; add --force to replace it`);
    throw new CliError(EXIT.usage, `${shown(path)}: cannot write the file`);
  }
}

/** Hex layout: --style if given, else the input's own layout when it was hex, else one line (what the NVIDIA Control Panel loads). */
export function hexStyleFor(style: string | undefined, source?: ImportedEdid): HexStyle {
  if (style === "one-line") return ONE_LINE_HEX_STYLE;
  if (style === "lines") return DEFAULT_HEX_STYLE;
  if (style !== undefined) throw new CliError(EXIT.usage, `--style must be one-line or lines, not ${printable(style, 20)}`);
  return source?.format === "hex" ? source.hexStyle : ONE_LINE_HEX_STYLE;
}
