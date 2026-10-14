import { useMemo, useState } from "react";
import { byteDiff, describeDtd, edidLayout, modeLabel, printable, serializeEdid } from "@edid-studio/core";
import type { LayoutNode } from "@edid-studio/core";
import { collectIssues } from "../issues.ts";
import { monitorName, nodeAtOffset, nodeLabel, preferredTiming } from "../model-view.ts";
import { current } from "../session.ts";
import type { Session } from "../session.ts";
import { HexView } from "./HexView.tsx";
import { Inspector } from "./Inspector.tsx";
import type { EditFn } from "./Inspector.tsx";
import { StructureTree } from "./StructureTree.tsx";

interface Props {
  readonly session: Session;
  readonly onEdit: EditFn;
}

export function Workspace({ session, onEdit }: Props) {
  const edid = current(session);
  const bytes = useMemo(() => serializeEdid(edid), [edid]);
  const layout = useMemo(() => edidLayout(edid), [edid]);
  const original = session.source.bytes;
  const diff = useMemo(() => byteDiff(original, bytes), [original, bytes]);
  const nodes = useMemo(() => layout.flatMap((b) => b.children), [layout]);
  const [selectedId, setSelectedId] = useState<string>(() => preferredNodeId(layout, edid));
  const [hovered, setHovered] = useState<LayoutNode | null>(null);
  const selected = nodes.find((n) => n.id === selectedId) ?? nodes[0];
  const issues = useMemo(() => collectIssues(edid, layout, session.source.checksumErrors), [edid, layout, session.source.checksumErrors]);

  const changed = (n: LayoutNode) => {
    if (n.ref.type === "checksum") return false;
    for (let i = n.start; i < n.end; i++) if (diff.changed[i]) return true;
    return false;
  };

  const pref = preferredTiming(edid);
  const prefInfo = pref?.kind === "dtd" ? describeDtd(pref) : undefined;
  const name = monitorName(edid);

  return (
    <>
      <div className="keyfacts">
        <div className="kf">
          <div className="n">{prefInfo ? modeLabel(prefInfo) : "none"}</div>
          <div className="l">first detailed timing{prefInfo ? `, ${(prefInfo.pixelClockKHz / 1000).toFixed(2)} MHz pixel clock` : ""}</div>
        </div>
        <div className="kf">
          <div className="n">{name === undefined ? "unnamed" : printable(name)}</div>
          <div className="l">monitor name</div>
        </div>
        <div className="kf">
          <div className="n">{bytes.length} bytes</div>
          <div className="l">
            {layout.length} {layout.length === 1 ? "block" : "blocks"}, EDID {edid.base.version}.{edid.base.revision}
          </div>
        </div>
        <div className="kf">
          <div className="n">{session.history.length - 1}</div>
          <div className="l">edits since import</div>
        </div>
      </div>

      <div className="panes">
        <StructureTree edid={edid} layout={layout} selectedId={selected?.id ?? ""} changed={changed} onSelect={setSelectedId} onHover={setHovered} />
        <HexView
          bytes={bytes}
          diff={diff}
          blockLabels={layout.map((b) => nodeLabel(edid, b))}
          selected={selected}
          hovered={hovered}
          onPick={(offset) => {
            const n = nodeAtOffset(layout, offset);
            if (n) setSelectedId(n.id);
          }}
        />
        <div className="side">
          {selected && <Inspector key={selected.id} edid={edid} bytes={bytes} node={selected} onEdit={onEdit} />}

          <section className="card" aria-labelledby="issues-title">
            <h2 className="section" id="issues-title">
              Issues
            </h2>
            {issues.length === 0 ? (
              <p className="empty">Nothing to report from import. Full validation rules arrive in a later release.</p>
            ) : (
              <ul className="issues">
                {issues.map((issue, i) => (
                  <li key={i} className={issue.severity}>
                    {issue.nodeId !== undefined ? (
                      <button onClick={() => issue.nodeId !== undefined && setSelectedId(issue.nodeId)}>{issue.message}</button>
                    ) : (
                      issue.message
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-labelledby="history-title">
            <h2 className="section" id="history-title">
              Edits
            </h2>
            <ol className="history">
              {session.history.map((h, i) => (
                <li key={i}>
                  <span className="n">{i}</span>
                  <span>{h.label}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    </>
  );
}

function preferredNodeId(layout: readonly LayoutNode[], edid: Parameters<typeof preferredTiming>[0]): string {
  const nodes = layout.flatMap((b) => b.children);
  const dtd = nodes.find((n) => n.ref.type === "baseDescriptor" && edid.base.descriptors[n.ref.index]?.kind === "dtd");
  return (dtd ?? nodes[0])?.id ?? "";
}
