// Recipes: a JSON list of operations applied to a base EDID, so any result
// can be reproduced, reviewed and shared (SPEC.md section 9).

import { EdidEncodeError } from "./errors.ts";
import type { ColourFormat, Depth } from "./link.ts";
import type { Edid } from "./model.ts";
import { autoRangeLimits, keepOnlyModes, setColor, setMonitorName, setPreferredTiming, setRangeLimits } from "./ops.ts";
import type { RangeLimitsSpec } from "./ops.ts";
import { buildTiming } from "./timing.ts";

export type RecipeOp =
  | { readonly op: "keepOnlyModes"; readonly modes: readonly number[] }
  | {
      readonly op: "setPreferredTiming";
      readonly width: number;
      readonly height: number;
      readonly refresh: string;
      /** "exact-refresh": the given blanking must give the refresh exactly, or the recipe fails. */
      readonly formula: "exact-refresh" | "manual";
      readonly hBlank: number;
      readonly vBlankLines: number;
      readonly hFrontPorch: number;
      readonly hSync: number;
      readonly vFrontPorch: number;
      readonly vSync: number;
      readonly polarity: "H+V-" | "H+V+" | "H-V+" | "H-V-";
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
  | { readonly op: "setMonitorName"; readonly name: string };

export interface Recipe {
  readonly recipe: 1;
  readonly base?: { readonly file: string };
  readonly ops: readonly RecipeOp[];
}

export function applyRecipeOp(edid: Edid, op: RecipeOp): Edid {
  switch (op.op) {
    case "keepOnlyModes":
      return keepOnlyModes(edid, { vics: op.modes });
    case "setPreferredTiming": {
      const r = buildTiming({
        hActive: op.width,
        vActive: op.height,
        refresh: op.refresh,
        formula: "manual",
        porches: {
          hFrontPorch: op.hFrontPorch,
          hSync: op.hSync,
          hBackPorch: op.hBlank - op.hFrontPorch - op.hSync,
          vFrontPorch: op.vFrontPorch,
          vSync: op.vSync,
          vBackPorch: op.vBlankLines - op.vFrontPorch - op.vSync,
        },
        hSyncPositive: op.polarity.startsWith("H+"),
        vSyncPositive: op.polarity.endsWith("V+"),
      });
      if (!r.dtd) throw new EdidEncodeError("preferred timing", r.dtdProblems.join("; "));
      if (op.formula === "exact-refresh" && !r.exact) {
        throw new EdidEncodeError("refresh", `this blanking gives ${r.achievedHz.toFixed(6)} Hz, ${r.errorPpm.toFixed(1)} ppm from ${op.refresh} Hz`);
      }
      return setPreferredTiming(edid, r.dtd);
    }
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
  }
}

/** Applies every operation in order. Each step's result must still serialize. */
export function runRecipe(base: Edid, recipe: Recipe): Edid {
  if (recipe.recipe !== 1) throw new EdidEncodeError("recipe", `unknown recipe version ${String(recipe.recipe)}`);
  return recipe.ops.reduce(applyRecipeOp, base);
}
