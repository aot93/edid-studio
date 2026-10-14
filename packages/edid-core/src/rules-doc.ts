// Renders docs/rules.md from the rule table, so the reference cannot drift
// from the code (a test compares them).

import { RULES } from "./validate.ts";

export function rulesMarkdown(): string {
  const tiers: Record<number, string> = { 1: "Tier 1: structure", 2: "Tier 2: semantics", 3: "Tier 3: link feasibility" };
  const lines = [
    "# Validation rules",
    "",
    "Generated from `packages/edid-core/src/validate.ts` by `pnpm rules-doc`; do not edit by hand.",
    "Errors block export. Warnings and notes do not. Severities follow `edid-decode` (fail is error,",
    "warn is warning), except where a hardware-verified EDID shows a source accepts it anyway.",
    "",
  ];
  for (const tier of [1, 2, 3] as const) {
    lines.push(`## ${tiers[tier]}`, "", "| ID | Severity | Rule |", "| --- | --- | --- |");
    for (const [id, r] of Object.entries(RULES)) if (r.tier === tier) lines.push(`| \`${id}\` | ${r.severity} | ${r.title} |`);
    lines.push("");
  }
  return lines.join("\n");
}
