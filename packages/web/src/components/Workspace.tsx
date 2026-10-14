import { useMemo, useState } from "react";
import { analyzeLink, byteDiff, describeDtd, edidLayout, LINKS, modeLabel, printable, serializeEdid } from "@edid-studio/core";
import type { LayoutNode, Link } from "@edid-studio/core";
import { collectIssues } from "../issues.ts";
import type { Issue } from "../issues.ts";
import { monitorName, nodeAtOffset, nodeLabel, preferredTiming } from "../model-view.ts";
import { current } from "../session.ts";
import type { Session } from "../session.ts";
import { HexView } from "./HexView.tsx";
import { Inspector } from "./Inspector.tsx";
import type { EditFn, TimingTarget } from "./Inspector.tsx";
import { StructureTree } from "./StructureTree.tsx";
import { TimingPanel } from "./TimingPanel.tsx";

interface Props {
  readonly session: Session;
  readonly onEdit: EditFn;
}

export function Workspace({ session, onEdit }: Props) {
  const edid = current(session);
  const bytes = useMemo(() => serializeEdid(edid), [edid]);
  const layout = useMemo(() => edidLayout(edid), [edid]);
  const original = session.source.bytes;
  const rawDiff = useMemo(() => byteDiff(original, bytes), [original, bytes]);
  // Zero padding that grows when content shrinks is not an edit worth flagging.
  const diff = useMemo(() => {
    const changed = [...rawDiff.changed];
    for (const n of layout.flatMap((b) => b.children)) {
      if (n.ref.type === "padding") for (let i = n.start; i < n.end; i++) if (bytes[i] === 0) changed[i] = false;
    }
    return { ...rawDiff, changed, added: changed.filter(Boolean).length };
  }, [rawDiff, layout, bytes]);
  const nodes = useMemo(() => layout.flatMap((b) => b.children), [layout]);
  const [selectedId, setSelectedId] = useState<string>(() => preferredNodeId(layout, edid));
  const [hovered, setHovered] = useState<LayoutNode | null>(null);
  const selected = nodes.find((n) => n.id === selectedId) ?? nodes[0];
  const [link, setLink] = useState<Link>("hdmi2.0");
  const [timingTarget, setTimingTarget] = useState<TimingTarget | null>(null);
  const issues = useMemo(() => {
    const linkIssues = analyzeLink(edid, link)
      .filter((r) => r.message !== "")
      .map((r): Issue => ({ severity: "error", message: r.message }));
    return [...linkIssues, ...collectIssues(edid, layout, session.source.checksumErrors)];
  }, [edid, layout, link, session.source.checksumErrors]);

  const changed = (n: LayoutNode) => {
    if (n.ref.type === "checksum" || n.ref.type === "padding") return false;
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

      <div className="toolbar">
        <label className="inline">
          Link
          <select value={link} onChange={(e) => setLink(e.target.value as Link)}>
            {(Object.keys(LINKS) as Link[]).map((l) => (
              <option key={l} value={l}>
                {LINKS[l].name}
              </option>
            ))}
          </select>
        </label>
        <button className="btn" onClick={() => setTimingTarget({ mode: "add" })}>
          Custom resolution…
        </button>
      </div>

      {timingTarget !== null && <TimingPanel key={JSON.stringify(timingTarget)} target={timingTarget} link={link} onEdit={onEdit} onClose={() => setTimingTarget(null)} />}

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
          {selected && <Inspector key={selected.id} edid={edid} bytes={bytes} node={selected} onEdit={onEdit} onTiming={setTimingTarget} />}

          <section className="card" aria-labelledby="issues-title">
            <h2 className="section" id="issues-title">
              Issues
            </h2>
            {issues.length === 0 ? (
              <p className="empty">Every advertised mode fits {LINKS[link].name} at every advertised depth. Full validation rules arrive in a later release.</p>
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
