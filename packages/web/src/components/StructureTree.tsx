import type { KeyboardEvent } from "react";
import type { Edid, LayoutNode } from "@edid-studio/core";
import { isRaw, nodeLabel } from "../model-view.ts";

interface Props {
  readonly edid: Edid;
  readonly layout: readonly LayoutNode[];
  readonly selectedId: string;
  readonly changed: (node: LayoutNode) => boolean;
  readonly onSelect: (id: string) => void;
  readonly onHover: (node: LayoutNode | null) => void;
}

/** Arrow keys move between items; Home and End jump to the ends. */
function onTreeKey(e: KeyboardEvent<HTMLElement>) {
  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-node]")];
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  const go = (i: number) => {
    const target = items[Math.max(0, Math.min(items.length - 1, i))];
    target?.focus();
    target?.click();
  };
  if (e.key === "ArrowDown") go(at + 1);
  else if (e.key === "ArrowUp") go(at - 1);
  else if (e.key === "Home") go(0);
  else if (e.key === "End") go(items.length - 1);
  else return;
  e.preventDefault();
}

export function StructureTree({ edid, layout, selectedId, changed, onSelect, onHover }: Props) {
  return (
    <nav aria-label="EDID structure" className="card">
      <h2 className="section">Structure</h2>
      <div className="tree" onKeyDown={onTreeKey} onMouseLeave={() => onHover(null)}>
        {layout.map((block) => (
          <div key={block.id} role="group" aria-label={nodeLabel(edid, block)}>
            <div className="blk">{nodeLabel(edid, block)}</div>
            <ul className="tree">
              {block.children.map((node) => (
                <li key={node.id}>
                  <button
                    data-node={node.id}
                    aria-current={node.id === selectedId}
                    tabIndex={node.id === selectedId ? 0 : -1}
                    onClick={() => onSelect(node.id)}
                    onMouseEnter={() => onHover(node)}
                    onFocus={() => onHover(node)}
                  >
                    <span className="t">{nodeLabel(edid, node)}</span>
                    {changed(node) && <span className="badge changed">edited</span>}
                    {isRaw(edid, node.ref) && <span className="badge">raw</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
