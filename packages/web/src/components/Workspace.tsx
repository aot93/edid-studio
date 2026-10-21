import { useMemo, useState } from "react";
import { byteDiff, describeDisplayIdTiming, describeDtd, edidLayout, LINKS, modeLabel, preferredDisplayIdTiming, printable, serializeEdid } from "@edid-studio/core";
import type { LayoutNode, Link } from "@edid-studio/core";
import { collectIssues, worstByNode } from "../issues.ts";
import { monitorName, nodeAtOffset, nodeLabel, preferredTiming } from "../model-view.ts";
import { current } from "../session.ts";
import type { Session } from "../session.ts";
import { HexView } from "./HexView.tsx";
import { Inspector } from "./Inspector.tsx";
import { LinkBudget } from "./LinkBudget.tsx";
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
  const issues = useMemo(() => collectIssues(edid, bytes, layout, session.source.checksumErrors, link), [edid, bytes, layout, session.source.checksumErrors, link]);
  const badges = useMemo(() => worstByNode(issues), [issues]);
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;

  const changed = (n: LayoutNode) => {
    if (n.ref.type === "checksum" || n.ref.type === "padding") return false;
    for (let i = n.start; i < n.end; i++) if (diff.changed[i]) return true;
    return false;
  };

  const pref = preferredTiming(edid);
  // A preferred DisplayID timing is the mode the EDID is built for; the base DTD is then its fallback.
  const prefId = preferredDisplayIdTiming(edid);
  const prefInfo = prefId ? describeDisplayIdTiming(prefId) : pref?.kind === "dtd" ? describeDtd(pref) : undefined;
  const name = monitorName(edid);

  return (
    <>
      <div className="keyfacts">
        <div className="kf">
          <div className="n">{prefInfo ? modeLabel(prefInfo) : "none"}</div>
          <div className="l">{prefId ? "preferred DisplayID timing" : "first detailed timing"}{prefInfo ? `, ${(prefInfo.pixelClockKHz / 1000).toFixed(2)} MHz pixel clock` : ""}</div>
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
        <StructureTree edid={edid} layout={layout} selectedId={selected?.id ?? ""} changed={changed} badges={badges} onSelect={setSelectedId} onHover={setHovered} />
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
            <p className={`summary ${errors > 0 ? "bad" : warnings > 0 ? "warn" : "good"}`} role="status">
              {errors > 0
                ? `${errors} ${errors === 1 ? "error" : "errors"}: export is blocked until ${errors === 1 ? "it is" : "they are"} fixed.`
                : warnings > 0
                  ? `No errors; ${warnings} ${warnings === 1 ? "warning" : "warnings"} to review.`
                  : `No errors or warnings. Every advertised mode fits ${LINKS[link].name}.`}
            </p>
            {issues.length > 0 && (
              <ul className="issues">
                {issues.map((issue, i) => (
                  <li key={i} className={issue.severity}>
                    <span className="sev">{issue.severity}</span>
                    {issue.rule && <code className="rule">{issue.rule}</code>}
                    <div>
                      {issue.nodeId !== undefined ? (
                        <button onClick={() => issue.nodeId !== undefined && setSelectedId(issue.nodeId)}>{issue.message}</button>
                      ) : (
                        issue.message
                      )}
                    </div>
                    {issue.fix && (
                      <button className="btn small fixbtn" onClick={() => issue.fix && onEdit(`Fix ${issue.rule ?? ""}: ${issue.fix.label}`, issue.fix.apply)}>
                        Fix: {issue.fix.label}
                      </button>
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

      <LinkBudget edid={edid} link={link} />
    </>
  );
}

function preferredNodeId(layout: readonly LayoutNode[], edid: Parameters<typeof preferredTiming>[0]): string {
  const nodes = layout.flatMap((b) => b.children);
  const dtd = nodes.find((n) => n.ref.type === "baseDescriptor" && edid.base.descriptors[n.ref.index]?.kind === "dtd");
  return (dtd ?? nodes[0])?.id ?? "";
}
