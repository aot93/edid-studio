// Import notes shown in the Issues panel. Full validation rules arrive with
// milestone M1; until then this reports what import already knows.

import type { Edid, LayoutNode } from "@edid-studio/core";
import { isRaw, nodeLabel } from "./model-view.ts";

export type Severity = "error" | "warning" | "info";

export interface Issue {
  readonly severity: Severity;
  readonly message: string;
  readonly nodeId?: string;
}

export function collectIssues(edid: Edid, layout: readonly LayoutNode[], checksumErrors: readonly string[]): Issue[] {
  const issues: Issue[] = checksumErrors.map((m) => ({
    severity: "warning",
    message: `${m}. Export writes correct checksums.`,
  }));
  for (const block of layout) {
    for (const node of block.children) {
      if (isRaw(edid, node.ref)) {
        issues.push({
          severity: "info",
          message: `${nodeLabel(edid, node)} is kept byte for byte; it is not decoded or editable yet.`,
          nodeId: node.id,
        });
      }
    }
  }
  return issues;
}
