// Issues shown in the editor: the rule engine's findings (SPEC.md section 8)
// plus what import alone knows (bad checksums in the file, blocks kept raw).

import { validateBytes } from "@edid-studio/core";
import type { Edid, Fix, LayoutNode, Link, NodeRef, RuleId } from "@edid-studio/core";
import { isRaw, nodeLabel } from "./model-view.ts";

export type Severity = "error" | "warning" | "info";

export interface Issue {
  readonly severity: Severity;
  readonly message: string;
  readonly rule?: RuleId;
  readonly nodeId?: string;
  readonly fix?: Fix;
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

function sameRef(a: NodeRef, b: NodeRef): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The layout node an issue points at, if any. */
export function nodeFor(layout: readonly LayoutNode[], where: NodeRef | undefined): string | undefined {
  if (!where) return undefined;
  for (const block of layout) {
    if (sameRef(block.ref, where)) return block.id;
    const child = block.children.find((c) => sameRef(c.ref, where));
    if (child) return child.id;
  }
  return undefined;
}

export function collectIssues(edid: Edid, bytes: Uint8Array, layout: readonly LayoutNode[], checksumErrors: readonly string[], link: Link): Issue[] {
  const report = validateBytes(bytes, { link });
  const issues: Issue[] = report.issues.map((i) => {
    const nodeId = nodeFor(layout, i.where);
    return { severity: i.severity, message: i.message, rule: i.rule, ...(nodeId ? { nodeId } : {}), ...(i.fix ? { fix: i.fix } : {}) };
  });
  for (const m of checksumErrors) issues.push({ severity: "info", message: `The imported file had a wrong checksum (${m}). Export writes correct ones.` });
  for (const block of layout) {
    for (const node of block.children) {
      if (isRaw(edid, node.ref)) {
        issues.push({ severity: "info", message: `${nodeLabel(edid, node)} is kept byte for byte; it is not decoded or editable yet.`, nodeId: node.id });
      }
    }
  }
  return issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** Worst severity per node, for badges in the structure tree. */
export function worstByNode(issues: readonly Issue[]): Map<string, Severity> {
  const out = new Map<string, Severity>();
  for (const i of issues) {
    if (!i.nodeId) continue;
    const cur = out.get(i.nodeId);
    if (!cur || SEVERITY_ORDER[i.severity] < SEVERITY_ORDER[cur]) out.set(i.nodeId, i.severity);
  }
  return out;
}
