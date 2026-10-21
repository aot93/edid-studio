// Recipes: a JSON list of operations applied to a base EDID, so any result
// can be reproduced, reviewed and shared (SPEC.md section 9). Recipe files
// are untrusted input (SPEC.md section 13): parseRecipe checks every field,
// refuses unknown ones, and quotes input only through printable().

import { describeChanges } from "./changes.ts";
import { addMode, removeMode, setAudio, setHdmiCaps, setIdentity, setSerial, stripAudio } from "./edit-ops.ts";
import { EdidEncodeError, RecipeError } from "./errors.ts";
import { FORMATS } from "./link.ts";
import type { ColourFormat, Depth } from "./link.ts";
import type { Edid } from "./model.ts";
import { addDisplayIdTiming, autoRangeLimits, keepOnlyModes, setColor, setMonitorName, setPreferredTiming, setRangeLimits } from "./ops.ts";
import type { RangeLimitsSpec } from "./ops.ts";
import { printable, MAX_INPUT_BYTES } from "./safety.ts";
import { buildTiming, FORMULA_NAMES } from "./timing.ts";
import type { Formula } from "./timing.ts";
import { validateEdid } from "./validate.ts";
import type { Issue } from "./validate.ts";

export type Polarity = "H+V-" | "H+V+" | "H-V+" | "H-V-";

export type RecipeOp =
  | { readonly op: "keepOnlyModes"; readonly modes: readonly number[] }
  | {
      readonly op: "setPreferredTiming";
      readonly width: number;
      readonly height: number;
      readonly refresh: string;
      /**
       * "exact-refresh": the given blanking must give the refresh exactly, or
       * the recipe fails. "manual": the given blanking as is. Any engine
       * formula ("exact", "cvt-rb", "vic", ...): computed, no blanking fields.
       * A raster too large for a DTD becomes the preferred DisplayID timing.
       */
      readonly formula: "exact-refresh" | Formula;
      readonly hBlank?: number;
      readonly vBlankLines?: number;
      readonly hFrontPorch?: number;
      readonly hSync?: number;
      readonly vFrontPorch?: number;
      readonly vSync?: number;
      readonly polarity?: Polarity;
    }
  | { readonly op: "setColor"; readonly formats: readonly ColourFormat[]; readonly depths: readonly Depth[] }
  | {
      readonly op: "setRangeLimits";
      readonly auto?: boolean;
      readonly vHz?: readonly [number, number];
      readonly hKHz?: readonly [number, number];
      readonly maxClockMHz?: number;
      readonly gtf?: "none" | "default";
    }
  | { readonly op: "setMonitorName"; readonly name: string }
  | { readonly op: "addMode"; readonly width: number; readonly height: number; readonly refresh: string; readonly formula: Formula; readonly encoding?: "auto" | "vic" | "dtd" | "displayid" }
  | { readonly op: "removeMode"; readonly width: number; readonly height: number; readonly refresh: number }
  | {
      readonly op: "setIdentity";
      readonly manufacturerId?: string;
      readonly productCode?: number;
      readonly serialNumber?: number;
      readonly name?: string;
      readonly serialText?: string;
      readonly week?: number;
      readonly year?: number;
    }
  | { readonly op: "setHdmiCaps"; readonly maxTmdsMHz?: number; readonly scdc?: boolean; readonly physicalAddress?: string }
  | { readonly op: "setAudio"; readonly channels: number; readonly ratesKHz: readonly number[]; readonly depths: readonly number[] }
  | { readonly op: "stripAudio" }
  | { readonly op: "setSerial"; readonly serial: number };

/** Checks on the result (SPEC.md section 9): length, first descriptor, block checksums, as hex. */
export interface RecipeExpect {
  readonly bytes?: number;
  readonly dtd?: string;
  readonly checksums?: readonly string[];
}

export interface Recipe {
  readonly recipe: 1;
  /** Base file, relative to the recipe. Absent: the caller supplies the base. */
  readonly base?: { readonly file: string };
  readonly ops: readonly RecipeOp[];
  readonly expect?: RecipeExpect;
}

// ---------------------------------------------------------------------------
// Parsing

type FieldType = "number" | "string" | "boolean" | "numbers" | "strings" | "pair";
type Fields = Record<string, { readonly type: FieldType; readonly required?: true; readonly oneOf?: readonly (string | number)[] }>;

const FORMULAS = Object.keys(FORMULA_NAMES);
const TIMING_FIELDS: Fields = {
  width: { type: "number", required: true },
  height: { type: "number", required: true },
  refresh: { type: "string", required: true },
};

/** Fields of each operation. Anything else is refused, so a typo cannot be silently ignored. */
const OPS: Record<RecipeOp["op"], Fields> = {
  keepOnlyModes: { modes: { type: "numbers", required: true } },
  setPreferredTiming: {
    ...TIMING_FIELDS,
    formula: { type: "string", required: true, oneOf: ["exact-refresh", ...FORMULAS] },
    hBlank: { type: "number" },
    vBlankLines: { type: "number" },
    hFrontPorch: { type: "number" },
    hSync: { type: "number" },
    vFrontPorch: { type: "number" },
    vSync: { type: "number" },
    polarity: { type: "string", oneOf: ["H+V-", "H+V+", "H-V+", "H-V-"] },
  },
  setColor: { formats: { type: "strings", required: true, oneOf: FORMATS }, depths: { type: "numbers", required: true, oneOf: [8, 10, 12, 16] } },
  setRangeLimits: { auto: { type: "boolean" }, vHz: { type: "pair" }, hKHz: { type: "pair" }, maxClockMHz: { type: "number" }, gtf: { type: "string", oneOf: ["none", "default"] } },
  setMonitorName: { name: { type: "string", required: true } },
  addMode: { ...TIMING_FIELDS, formula: { type: "string", required: true, oneOf: FORMULAS }, encoding: { type: "string", oneOf: ["auto", "vic", "dtd", "displayid"] } },
  removeMode: { width: { type: "number", required: true }, height: { type: "number", required: true }, refresh: { type: "number", required: true } },
  setIdentity: {
    manufacturerId: { type: "string" },
    productCode: { type: "number" },
    serialNumber: { type: "number" },
    name: { type: "string" },
    serialText: { type: "string" },
    week: { type: "number" },
    year: { type: "number" },
  },
  setHdmiCaps: { maxTmdsMHz: { type: "number" }, scdc: { type: "boolean" }, physicalAddress: { type: "string" } },
  setAudio: { channels: { type: "number", required: true }, ratesKHz: { type: "numbers", required: true }, depths: { type: "numbers", required: true } },
  stripAudio: {},
  setSerial: { serial: { type: "number", required: true } },
};

const MAX_OPS = 1000;

const quote = (v: unknown) => `"${printable(String(v), 40)}"`;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkFields(where: string, obj: Record<string, unknown>, fields: Fields, skip: readonly string[] = []): void {
  for (const key of Object.keys(obj)) {
    if (!(key in fields) && !skip.includes(key)) throw new RecipeError(`${where}: unknown field ${quote(key)}`);
  }
  for (const [key, spec] of Object.entries(fields)) {
    const v = obj[key];
    if (v === undefined) {
      if (spec.required) throw new RecipeError(`${where}: ${quote(key)} is required`);
      continue;
    }
    const finite = (x: unknown) => typeof x === "number" && Number.isFinite(x);
    const ok =
      spec.type === "number"
        ? finite(v)
        : spec.type === "string"
          ? typeof v === "string"
          : spec.type === "boolean"
            ? typeof v === "boolean"
            : spec.type === "numbers"
              ? Array.isArray(v) && v.every(finite)
              : spec.type === "strings"
                ? Array.isArray(v) && v.every((x) => typeof x === "string")
                : Array.isArray(v) && v.length === 2 && v.every(finite);
    if (!ok) {
      const kind = { number: "a number", string: "a string", boolean: "true or false", numbers: "a list of numbers", strings: "a list of strings", pair: "a list of two numbers" }[spec.type];
      throw new RecipeError(`${where}: ${quote(key)} must be ${kind}`);
    }
    if (spec.oneOf) {
      const bad = (Array.isArray(v) ? v : [v]).find((x) => !spec.oneOf?.includes(x as string | number));
      if (bad !== undefined) throw new RecipeError(`${where}: ${quote(key)} cannot be ${quote(bad)}; choose from ${spec.oneOf.join(", ")}`);
    }
  }
}

/** Reads a recipe from JSON text, checking every field. Throws RecipeError (an EdidParseError). */
export function parseRecipe(text: string): Recipe {
  if (text.length > MAX_INPUT_BYTES) throw new RecipeError(`recipe is ${text.length} characters; the limit is ${MAX_INPUT_BYTES}`);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new RecipeError("recipe is not valid JSON");
  }
  if (!isObject(data)) throw new RecipeError("recipe must be a JSON object");
  checkFields("recipe", data, { recipe: { type: "number", required: true } }, ["base", "ops", "expect"]);
  if (data["recipe"] !== 1) throw new RecipeError(`unknown recipe version ${quote(data["recipe"])}; this tool reads version 1`);

  let base: Recipe["base"];
  if (data["base"] !== undefined) {
    const b = data["base"];
    if (!isObject(b)) throw new RecipeError(`"base" must be an object like {"file": "original.txt"}`);
    if (typeof b["file"] !== "string") throw new RecipeError(`"base.file" must be a string`);
    checkFields("base", b, { file: { type: "string", required: true } });
    base = { file: b["file"] };
  }

  const ops = data["ops"];
  if (!Array.isArray(ops)) throw new RecipeError(`"ops" must be a list of operations`);
  if (ops.length > MAX_OPS) throw new RecipeError(`recipe has ${ops.length} operations; the limit is ${MAX_OPS}`);
  const parsed = ops.map((o, i): RecipeOp => {
    if (!isObject(o)) throw new RecipeError(`op ${i + 1}: must be an object with an "op" field`);
    const name = o["op"];
    if (typeof name !== "string" || !Object.hasOwn(OPS, name)) throw new RecipeError(`op ${i + 1}: unknown operation ${quote(name)}`);
    const fields = OPS[name as RecipeOp["op"]];
    checkFields(`op ${i + 1} (${name})`, o, fields, ["op"]);
    return o as unknown as RecipeOp;
  });

  let expectBlock: RecipeExpect | undefined;
  if (data["expect"] !== undefined) {
    const x = data["expect"];
    if (!isObject(x)) throw new RecipeError(`"expect" must be an object`);
    checkFields("expect", x, { bytes: { type: "number" }, dtd: { type: "string" }, checksums: { type: "strings" } });
    expectBlock = x as RecipeExpect;
  }
  return { recipe: 1, ...(base ? { base } : {}), ops: parsed, ...(expectBlock ? { expect: expectBlock } : {}) };
}

// ---------------------------------------------------------------------------
// Running

export function applyRecipeOp(edid: Edid, op: RecipeOp): Edid {
  switch (op.op) {
    case "keepOnlyModes":
      return keepOnlyModes(edid, { vics: op.modes });
    case "setPreferredTiming":
      return preferredTiming(edid, op);
    case "setColor":
      return setColor(edid, op.formats, op.depths);
    case "setRangeLimits": {
      let spec: RangeLimitsSpec | undefined;
      if (op.auto) spec = autoRangeLimits(edid, op.gtf ?? "none");
      else if (op.vHz && op.hKHz && op.maxClockMHz !== undefined) spec = { vHz: op.vHz, hKHz: op.hKHz, maxClockMHz: op.maxClockMHz, gtf: op.gtf ?? "none" };
      if (!spec) throw new EdidEncodeError("range limits", "give vHz, hKHz and maxClockMHz, or auto: true");
      return setRangeLimits(edid, spec);
    }
    case "setMonitorName":
      return setMonitorName(edid, op.name);
    case "addMode":
      return addMode(edid, { width: op.width, height: op.height, refresh: op.refresh, formula: op.formula, ...(op.encoding ? { encoding: op.encoding } : {}) });
    case "removeMode":
      return removeMode(edid, { width: op.width, height: op.height, refreshHz: op.refresh });
    case "setIdentity":
      return setIdentity(edid, op);
    case "setHdmiCaps":
      return setHdmiCaps(edid, op);
    case "setAudio":
      return setAudio(edid, op);
    case "stripAudio":
      return stripAudio(edid);
    case "setSerial":
      return setSerial(edid, op.serial);
  }
}

function preferredTiming(edid: Edid, op: Extract<RecipeOp, { op: "setPreferredTiming" }>): Edid {
  const polarity = op.polarity ?? "H+V-";
  const pol = { hSyncPositive: polarity.startsWith("H+"), vSyncPositive: polarity.endsWith("V+") };
  let r;
  if (op.formula === "exact-refresh" || op.formula === "manual") {
    const need = ["hBlank", "vBlankLines", "hFrontPorch", "hSync", "vFrontPorch", "vSync"] as const;
    const missing = need.filter((k) => op[k] === undefined);
    if (missing.length > 0) throw new EdidEncodeError("preferred timing", `formula "${op.formula}" needs ${missing.join(", ")}`);
    const n = (k: (typeof need)[number]) => op[k] ?? 0;
    r = buildTiming({
      hActive: op.width,
      vActive: op.height,
      refresh: op.refresh,
      formula: "manual",
      porches: {
        hFrontPorch: n("hFrontPorch"),
        hSync: n("hSync"),
        hBackPorch: n("hBlank") - n("hFrontPorch") - n("hSync"),
        vFrontPorch: n("vFrontPorch"),
        vSync: n("vSync"),
        vBackPorch: n("vBlankLines") - n("vFrontPorch") - n("vSync"),
      },
      ...pol,
    });
    if (op.formula === "exact-refresh" && !r.exact) {
      throw new EdidEncodeError("refresh", `this blanking gives ${r.achievedHz.toFixed(6)} Hz, ${r.errorPpm.toFixed(1)} ppm from ${op.refresh} Hz`);
    }
  } else {
    r = buildTiming({ hActive: op.width, vActive: op.height, refresh: op.refresh, formula: op.formula, ...(op.polarity ? pol : {}) });
  }
  if (r.dtd) return setPreferredTiming(edid, r.dtd);
  if (r.displayId) return addDisplayIdTiming(edid, r.displayId);
  throw new EdidEncodeError("preferred timing", r.dtdProblems.join("; "));
}

/** A short label for a step, for logs and the UI history. */
export function opLabel(op: RecipeOp): string {
  switch (op.op) {
    case "keepOnlyModes":
      return op.modes.length > 0 ? `keepOnlyModes VIC ${op.modes.join(", ")}` : "keepOnlyModes";
    case "setPreferredTiming":
    case "addMode":
      return `${op.op} ${op.width}x${op.height} @ ${op.refresh} Hz`;
    case "removeMode":
      return `removeMode ${op.width}x${op.height} @ ${op.refresh} Hz`;
    case "setColor":
      return `setColor ${op.formats.join(", ")}, ${op.depths.join(", ")}-bit`;
    case "setRangeLimits":
      return op.auto ? "setRangeLimits auto" : `setRangeLimits ${op.vHz?.join("-")} Hz, ${op.hKHz?.join("-")} kHz, ${op.maxClockMHz} MHz`;
    case "setMonitorName":
      return `setMonitorName ${quote(op.name)}`;
    case "setSerial":
      return `setSerial ${op.serial}`;
    default:
      return op.op;
  }
}

export interface RecipeStep {
  readonly op: RecipeOp;
  readonly label: string;
  /** Plain-language changes this step made. */
  readonly changes: readonly string[];
  /** Validator issues after this step. */
  readonly issues: readonly Issue[];
}

/**
 * Applies every operation in order, reporting what each changed and what the
 * validator says afterwards (SPEC.md section 9). A failing step names itself:
 * "op 2 (removeMode): ...".
 */
export function runRecipeSteps(base: Edid, recipe: Recipe): { edid: Edid; steps: RecipeStep[] } {
  if (recipe.recipe !== 1) throw new RecipeError(`unknown recipe version ${quote(recipe.recipe)}`);
  const steps: RecipeStep[] = [];
  let edid = base;
  recipe.ops.forEach((op, i) => {
    let next: Edid;
    try {
      next = applyRecipeOp(edid, op);
    } catch (e) {
      if (e instanceof EdidEncodeError) throw new EdidEncodeError(e.field, `op ${i + 1} (${op.op}): ${e.message}`);
      throw e;
    }
    steps.push({ op, label: opLabel(op), changes: describeChanges(edid, next), issues: validateEdid(next) });
    edid = next;
  });
  return { edid, steps };
}

/** Applies every operation in order. */
export function runRecipe(base: Edid, recipe: Recipe): Edid {
  return runRecipeSteps(base, recipe).edid;
}

/** What the result gets wrong against an expect block. Empty when it all holds. */
export function checkExpect(bytes: ArrayLike<number>, expect: RecipeExpect): string[] {
  const hex = (from: number, to: number) => Array.from({ length: Math.max(0, Math.min(to, bytes.length) - from) }, (_, i) => (bytes[from + i] ?? 0).toString(16).padStart(2, "0")).join(" ");
  const out: string[] = [];
  if (expect.bytes !== undefined && expect.bytes !== bytes.length) out.push(`expected ${expect.bytes} bytes, got ${bytes.length}`);
  if (expect.dtd !== undefined) {
    const want = expect.dtd.trim().toLowerCase().split(/\s+/).join(" ");
    const got = hex(54, 72);
    if (want !== got) out.push(`expected the first descriptor to be ${printable(want, 60)}, got ${got}`);
  }
  expect.checksums?.forEach((c, block) => {
    const got = hex(block * 128 + 127, block * 128 + 128);
    if (c.toLowerCase() !== got) out.push(`expected block ${block} checksum ${printable(c, 4)}, got ${got || "nothing (no such block)"}`);
  });
  return out;
}
