// Golden outputs (SPEC.md section 8): EDIDs the tool produces, checked by
// edid-decode --check in CI. Acceptance test 7 requires no errors; the only
// allowed failures are the ones pinned here, each with its reason.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildEdid, buildTiming, importEdid, runRecipe, serializeEdid } from "../src/index.ts";
import type { BuildIntent, Recipe } from "../src/index.ts";
import { FIXTURES_DIR } from "./corpus.ts";

export interface Golden {
  readonly name: string;
  readonly bytes: () => Uint8Array;
  /** edid-decode failures that are expected, exactly. Empty means a clean pass. */
  readonly expectFailures: readonly string[];
  readonly why?: string;
}

const timing = (w: number, h: number, hz: string, formula: "exact" | "cvt-rb" = "exact") => {
  const r = buildTiming({ hActive: w, vActive: h, refresh: hz, formula });
  if (!r.dtd) throw new Error(r.dtdProblems.join("; "));
  return r.dtd;
};

const base: Omit<BuildIntent, "timing"> = {
  name: "LED wall",
  manufacturerId: "VYV",
  productCode: 1,
  year: 2026,
  link: "hdmi2.0",
  formats: ["rgb"],
  depths: [10],
  include640x480: true,
};

const NO_640 = "Required 640x480p60 timings are missing in the established timings and the SVD list (VIC 1).";

const TESSERA_RECIPE: Recipe = {
  recipe: 1,
  ops: [
    { op: "keepOnlyModes", modes: [] },
    { op: "setPreferredTiming", width: 3840, height: 2160, refresh: "50", formula: "exact-refresh", hBlank: 160, vBlankLines: 60, hFrontPorch: 48, hSync: 32, vFrontPorch: 8, vSync: 10, polarity: "H+V-" },
    { op: "setColor", formats: ["rgb"], depths: [10] },
    { op: "setRangeLimits", vHz: [50, 50], hKHz: [110, 113], maxClockMHz: 600, gtf: "none" },
  ],
};

export const GOLDEN: readonly Golden[] = [
  { name: "4K50 10-bit RGB, HDMI 2.0", bytes: () => serializeEdid(buildEdid({ ...base, timing: timing(3840, 2160, "50") })), expectFailures: [] },
  { name: "4K30 10-bit RGB, HDMI 2.0", bytes: () => serializeEdid(buildEdid({ ...base, timing: timing(3840, 2160, "30") })), expectFailures: [] },
  { name: "3840x1080 50 Hz 10-bit", bytes: () => serializeEdid(buildEdid({ ...base, timing: timing(3840, 1080, "50") })), expectFailures: [] },
  { name: "2688x1536 50 Hz 12-bit with 4:4:4", bytes: () => serializeEdid(buildEdid({ ...base, formats: ["rgb", "ycbcr444"], depths: [10, 12], timing: timing(2688, 1536, "50") })), expectFailures: [] },
  { name: "1080p59.94 CVT-RB, 4:2:2 allowed", bytes: () => serializeEdid(buildEdid({ ...base, formats: ["rgb", "ycbcr422"], timing: timing(1920, 1080, "59.94", "cvt-rb") })), expectFailures: [] },
  { name: "1080p60 8-bit, HDMI 1.4", bytes: () => serializeEdid(buildEdid({ ...base, link: "hdmi1.4", depths: [8], timing: timing(1920, 1080, "60") })), expectFailures: [] },
  { name: "1920x1200 60 Hz, DVI", bytes: () => serializeEdid(buildEdid({ ...base, link: "dvi", depths: [8], timing: timing(1920, 1200, "60") })), expectFailures: [] },
  {
    name: "4K50 10-bit, single mode (no 640x480)",
    bytes: () => serializeEdid(buildEdid({ ...base, include640x480: false, timing: timing(3840, 2160, "50") })),
    expectFailures: [NO_640],
    why: "Owner decision 2026-10-14: built EDIDs hold one mode by default (SPEC.md section 14, finding 7).",
  },
  {
    name: "Tessera recipe output",
    bytes: () => serializeEdid(runRecipe(importEdid(readFileSync(join(FIXTURES_DIR, "Tessera-EJE-test.txt"), "utf8")).edid, TESSERA_RECIPE)),
    expectFailures: [
      NO_640,
      "The chromaticities match sRGB, but sRGB is not signaled.",
      "'Range Limits Only' is not allowed for EDID < 1.4.",
    ],
    why: "Byte-identical to the hardware-verified Tessera EDID, which the NVIDIA driver accepted with these (SPEC.md section 14).",
  },
];
