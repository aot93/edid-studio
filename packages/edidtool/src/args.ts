// Argument helpers over node:util parseArgs: strict options, and numbers and
// lists checked with messages that name the option.

import { parseArgs } from "node:util";
import { DEPTHS, FORMATS, FORMULA_NAMES, LINKS, printable } from "@edid-studio/core";
import type { ColourFormat, Depth, Formula, Link } from "@edid-studio/core";
import { CliError, EXIT } from "./io.ts";

type Options = NonNullable<Parameters<typeof parseArgs>[0]>["options"];

export interface Parsed {
  readonly values: Record<string, string | boolean | undefined>;
  readonly positionals: readonly string[];
}

export function parse(args: readonly string[], options: Options): Parsed {
  try {
    const r = parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
    return { values: r.values as Record<string, string | boolean | undefined>, positionals: r.positionals };
  } catch (e) {
    throw new CliError(EXIT.usage, printable((e as Error).message, 200));
  }
}

export function str(p: Parsed, name: string): string | undefined {
  const v = p.values[name];
  return typeof v === "string" ? v : undefined;
}

export function required(p: Parsed, name: string): string {
  const v = str(p, name);
  if (v === undefined) throw new CliError(EXIT.usage, `--${name} is required`);
  return v;
}

export function int(p: Parsed, name: string): number | undefined {
  const v = str(p, name);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new CliError(EXIT.usage, `--${name} must be a whole number, not ${printable(v, 20)}`);
  return Number(v);
}

export function requiredInt(p: Parsed, name: string): number {
  const v = int(p, name);
  if (v === undefined) throw new CliError(EXIT.usage, `--${name} is required`);
  return v;
}

export function flag(p: Parsed, name: string): boolean {
  return p.values[name] === true;
}

export function positional(p: Parsed, index: number, what: string): string {
  const v = p.positionals[index];
  if (v === undefined) throw new CliError(EXIT.usage, `missing ${what}`);
  return v;
}

export function formula(p: Parsed, fallback: Formula = "exact"): Formula {
  const v = str(p, "formula") ?? fallback;
  if (!Object.hasOwn(FORMULA_NAMES, v)) throw new CliError(EXIT.usage, `--formula must be one of ${Object.keys(FORMULA_NAMES).join(", ")}`);
  return v as Formula;
}

export function link(p: Parsed): Link {
  const v = str(p, "link") ?? "hdmi2.0";
  if (!Object.hasOwn(LINKS, v)) throw new CliError(EXIT.usage, `--link must be one of ${Object.keys(LINKS).join(", ")}`);
  return v as Link;
}

export function colours(p: Parsed, fallback: string): ColourFormat[] {
  return (str(p, "color") ?? fallback).split(",").map((c) => {
    if (!(FORMATS as readonly string[]).includes(c)) throw new CliError(EXIT.usage, `--color must be from ${FORMATS.join(", ")}, not ${printable(c, 20)}`);
    return c as ColourFormat;
  });
}

export function depths(p: Parsed, fallback: string): Depth[] {
  return (str(p, "depth") ?? fallback).split(",").map((d) => {
    const n = Number(d);
    if (!(DEPTHS as readonly number[]).includes(n)) throw new CliError(EXIT.usage, `--depth must be from ${DEPTHS.join(", ")}, not ${printable(d, 20)}`);
    return n as Depth;
  });
}
