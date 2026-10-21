import { useState } from "react";
import type { ReactNode } from "react";
import {
  describeDisplayIdTiming,
  describeDtd,
  lookupVic,
  manufacturerId,
  modeLabel,
  printable,
  removeDataBlock,
  removeDescriptor,
  removeSvd,
  setHdmiDeepColour,
  makePreferred,
  setHf420DeepColour,
  setMonitorName,
} from "@edid-studio/core";
import type { DetailedTimingDescriptor, Descriptor, DisplayIdTiming, Edid, LayoutNode } from "@edid-studio/core";
import { ctaAt, dataBlockAt, descriptorAt, displayIdAt, displayIdBlockAt, hex, nodeLabel, svdLabel } from "../model-view.ts";
import { ColourForm, EstablishedTimingsEditor, RangeLimitsEditor, StandardTimingsEditor } from "./BaseEditors.tsx";

export type EditFn = (label: string, edit: (edid: Edid) => Edid) => string | null;

/** Where a timing edit lands: a new timing, or a replacement for an existing DTD. */
export type TimingTarget =
  | { readonly mode: "add" }
  | { readonly mode: "replace"; readonly where: { readonly extension?: number; readonly index: number }; readonly dtd: DetailedTimingDescriptor };

interface Props {
  readonly edid: Edid;
  readonly bytes: Uint8Array;
  readonly node: LayoutNode;
  /** Applies an edit; returns an error message, or null on success. */
  readonly onEdit: EditFn;
  readonly onTiming: (target: TimingTarget) => void;
}

function Fields({ rows }: { readonly rows: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="fields">
      {rows.map(([k, v]) => (
        <div key={k} className="pair">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Check({ label, checked, onChange }: { readonly label: string; readonly checked: boolean; readonly onChange: (v: boolean) => void }) {
  return (
    <label>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** DisplayID 1.x product types (edid-decode product_type()). */
const PRODUCT_TYPES: Record<number, string> = {
  0: "Extension section",
  1: "Test structure",
  2: "Display panel",
  3: "Standalone display",
  4: "Television",
  5: "Repeater / translator",
  6: "Direct-drive monitor",
};

function DisplayIdTimingView({ t }: { readonly t: DisplayIdTiming }) {
  const i = describeDisplayIdTiming(t);
  return (
    <Fields
      rows={[
        ["Mode", `${modeLabel(i)}${t.flags & 0x80 ? " (preferred)" : ""}`],
        ["Pixel clock", mhz(i.pixelClockKHz)],
        ["Total", `${i.hTotal} x ${i.vTotal}`],
        ["H front / sync / back", `${t.hFrontPorch} / ${t.hSync} / ${i.hBackPorch}`],
        ["V front / sync / back", `${t.vFrontPorch} / ${t.vSync} / ${i.vBackPorch}`],
        ["Polarity", `H${t.hSyncPositive ? "+" : "-"} V${t.vSyncPositive ? "+" : "-"}`],
        ["Refresh (exact)", `${i.refreshHz.toFixed(6)} Hz`],
      ]}
    />
  );
}

const mhz = (khz: number) => `${(khz / 1000).toFixed(khz % 1000 === 0 ? 0 : 3)} MHz`;
const yesNo = (v: boolean) => (v ? "yes" : "no");

const INTERFACES = ["not defined", "DVI", "HDMI-a", "HDMI-b", "MDDI", "DisplayPort"];

/** Base byte 20 (E-EDID 1.4 table 3.11; edid-decode parse_base_block()). */
function videoInput(edid: Edid): string {
  const v = edid.base.videoInput;
  if (!(v & 0x80)) return "Analog";
  if (edid.base.revision < 4) return "Digital (EDID 1.3: no bit depth field)";
  const depth = (v & 0x70) === 0 ? "depth undefined" : (v & 0x70) === 0x70 ? "reserved depth" : `${((v & 0x70) >> 3) + 4}-bit`;
  return `Digital, ${depth}, ${INTERFACES[v & 0x0f] ?? `interface 0x${hex(v & 0x0f)}`}`;
}

interface DescriptorProps {
  readonly d: Descriptor;
  readonly edid: Edid;
  readonly where: { readonly extension?: number; readonly index: number };
  readonly onEdit: EditFn;
  readonly onTiming: (target: TimingTarget) => void;
  readonly edit: (label: string, f: (e: Edid) => Edid) => void;
}

function DescriptorView({ d, edid, where, onEdit, onTiming, edit }: DescriptorProps) {
  const [name, setName] = useState(d.kind === "text" ? d.text : "");
  const [error, setError] = useState<string | null>(null);

  switch (d.kind) {
    case "dtd": {
      const t = describeDtd(d);
      return (
        <>
        <Fields
          rows={[
            ["Mode", modeLabel(t)],
            ["Pixel clock", mhz(t.pixelClockKHz)],
            ["Total", `${t.hTotal} x ${t.vTotal}`],
            ["H front / sync / back", `${d.hFrontPorch} / ${d.hSync} / ${t.hBackPorch}`],
            ["V front / sync / back", `${d.vFrontPorch} / ${d.vSync} / ${t.vBackPorch}`],
            ["Polarity", `H${t.hSyncPositive ? "+" : "-"} V${t.vSyncPositive ? "+" : "-"}`],
            ["Image size", d.hImageMm || d.vImageMm ? `${d.hImageMm} x ${d.vImageMm} mm` : "unspecified"],
            ["Refresh (exact)", `${t.refreshHz.toFixed(6)} Hz`],
          ]}
        />
        <div className="row">
          <button className="btn small" onClick={() => onTiming({ mode: "replace", where, dtd: d })}>
            Edit timing
          </button>
          {!(where.extension === undefined && where.index === 0) && (
            <button
              className="btn small"
              onClick={() => edit(`Make ${modeLabel(t)} the preferred timing`, (e) => makePreferred(e, where))}
            >
              Make preferred
            </button>
          )}
          <button className="btn small danger" onClick={() => edit(`Remove timing ${modeLabel(t)}`, (e) => removeDescriptor(e, where))}>
            Remove timing
          </button>
        </div>
        </>
      );
    }
    case "text":
      if (d.tag !== 0xfc) return <Fields rows={[["Text", printable(d.text)]]} />;
      return (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError(onEdit(`Set monitor name to "${printable(name)}"`, (x) => setMonitorName(x, name)));
          }}
        >
          <label htmlFor="mon-name" className="sub">
            Monitor name (up to 13 characters)
          </label>
          <div className="text-edit">
            <input id="mon-name" value={name} maxLength={13} spellCheck={false} onChange={(e) => setName(e.target.value)} />
            <button className="btn small" type="submit" disabled={name === d.text}>
              Apply
            </button>
          </div>
          {error !== null && <p className="field-error">{error}</p>}
        </form>
      );
    case "rangeLimits":
      return (
        <>
          {d.offsetFlags !== 0 && <p className="note">Rate offsets are set (EDID 1.4): add 255 to the flagged limits.</p>}
          <RangeLimitsEditor key={JSON.stringify(d)} edid={edid} d={d} edit={edit} />
        </>
      );
    case "dummy":
      return (
        <>
          <p className="note">An unused descriptor slot. It can hold a timing, range limits or a monitor name.</p>
          <div className="row">
            <button className="btn small" onClick={() => onTiming({ mode: "add" })}>
              Add a timing
            </button>
          </div>
        </>
      );
    case "raw":
      return <p className="note">Kept byte for byte; not decoded.</p>;
  }
}

export function Inspector({ edid, bytes, node, onEdit, onTiming }: Props) {
  const [error, setError] = useState<string | null>(null);
  const r = node.ref;
  const edit = (label: string, f: (e: Edid) => Edid) => setError(onEdit(label, f));
  let body: ReactNode = null;

  if (r.type === "baseIdentity") {
    const b = edid.base;
    body = (
      <Fields
        rows={[
          ["Manufacturer", manufacturerId(b.manufacturerCode)],
          ["Product code", `0x${hex(b.productCode, 4)}`],
          ["Serial number", b.serialNumber === 0 ? "not set" : String(b.serialNumber)],
          ["Made", b.week === 0xff ? `model year ${1990 + b.yearOffset}` : `week ${b.week}, ${1990 + b.yearOffset}`],
        ]}
      />
    );
  } else if (r.type === "baseVersion") {
    body = <Fields rows={[["Version", `${edid.base.version}.${edid.base.revision}`]]} />;
  } else if (r.type === "baseDisplay") {
    body = (
      <Fields
        rows={[
          ["Input", videoInput(edid)],
          ["Screen size", edid.base.screenSize[0] && edid.base.screenSize[1] ? `${edid.base.screenSize[0]} x ${edid.base.screenSize[1]} cm` : "unspecified"],
        ]}
      />
    );
  } else if (r.type === "baseDescriptor" || r.type === "ctaDescriptor") {
    const d = descriptorAt(edid, r);
    const where = r.type === "baseDescriptor" ? { index: r.index } : { extension: r.extension, index: r.index };
    if (d) body = <DescriptorView key={node.id + JSON.stringify(d)} d={d} edid={edid} where={where} onEdit={onEdit} onTiming={onTiming} edit={edit} />;
  } else if (r.type === "standardTimings") {
    body = <StandardTimingsEditor edid={edid} edit={edit} />;
  } else if (r.type === "establishedTimings") {
    body = <EstablishedTimingsEditor edid={edid} edit={edit} />;
  } else if (r.type === "ctaHeader") {
    const cta = ctaAt(edid, r.extension);
    if (cta) {
      body = (
        <>
          <Fields rows={[["Revision", String(cta.revision)], ["Underscan", yesNo(cta.underscan)], ["Basic audio", yesNo(cta.basicAudio)], ["Native DTDs", String(cta.nativeDtdCount)]]} />
          <ColourForm key={JSON.stringify([cta.ycbcr444, cta.ycbcr422, cta.dataBlocks.length])} edid={edid} edit={edit} />
        </>
      );
    }
  } else if (r.type === "displayIdHeader") {
    const id = displayIdAt(edid, r.extension);
    if (id) {
      body = (
        <>
          <Fields
            rows={[
              ["Version", `${id.version >> 4}.${id.version & 0xf}`],
              [id.version < 0x20 ? "Product type" : "Primary use", id.version < 0x20 ? (PRODUCT_TYPES[id.productType] ?? `0x${hex(id.productType)}`) : `0x${hex(id.productType)}`],
              ["Extension sections", String(id.extensionCount)],
            ]}
          />
          <p className="note">Carries timings a detailed timing descriptor cannot hold: up to 65536 x 65536 and clocks above 655.35 MHz.</p>
          <div className="row">
            <button className="btn small" onClick={() => onTiming({ mode: "add" })}>
              Add a timing
            </button>
          </div>
        </>
      );
    }
  } else if (r.type === "displayIdBlock") {
    const b = displayIdBlockAt(edid, r);
    if (b?.kind === "type1Timings") {
      body = (
        <>
          {b.timings.map((t, i) => (
            <DisplayIdTimingView key={i} t={t} />
          ))}
        </>
      );
    } else if (b) {
      body = <p className="note">Kept byte for byte; not decoded.</p>;
    }
  } else if (r.type === "displayIdFiller") {
    body = <p className="note">Zero bytes inside the DisplayID section after its data blocks.</p>;
  } else if (r.type === "displayIdChecksum") {
    body = <p className="note">Makes bytes 1 to here of the DisplayID section sum to zero. Written by EDID Studio on every export.</p>;
  } else if (r.type === "dataBlock") {
    body = <DataBlockView edid={edid} extension={r.extension} index={r.index} edit={edit} />;
  } else if (r.type === "extensionCount") {
    body = <Fields rows={[["Extension blocks", String(edid.extensions.length)]]} />;
  } else if (r.type === "checksum") {
    body = <p className="note">Written by EDID Studio on every export so the block sums to zero.</p>;
  } else if (r.type === "padding") {
    body = <p className="note">Zero bytes up to the checksum.</p>;
  } else if (r.type === "rawExtension") {
    body = <p className="note">This extension type is kept byte for byte and is not decoded yet.</p>;
  }

  return (
    <section className="card insp" aria-labelledby="insp-title">
      <h2 className="section">Inspector</h2>
      <h3 id="insp-title">{nodeLabel(edid, node)}</h3>
      <div className="range">
        bytes {node.start}–{node.end - 1} · {Array.from(bytes.subarray(node.start, Math.min(node.end, node.start + 8)), (b) => hex(b)).join(" ")}
        {node.end - node.start > 8 ? " …" : ""}
      </div>
      {body}
      {error !== null && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** Which SVDs the 4:2:0 capability map flags, by global SVD index (edid-decode cta_y420cmdb()). */
function y420Indexes(edid: Edid): Set<number> | "all" | null {
  for (const e of edid.extensions) {
    if (e.kind !== "cta") continue;
    for (const b of e.dataBlocks) {
      if (b.kind !== "ycbcr420CapabilityMap") continue;
      if (b.bitmap.length === 0) return "all";
      const s = new Set<number>();
      b.bitmap.forEach((byte, i) => {
        for (let j = 0; j < 8; j++) if ((byte >> j) & 1) s.add(i * 8 + j);
      });
      return s;
    }
  }
  return null;
}

function DataBlockView({ edid, extension, index, edit }: { readonly edid: Edid; readonly extension: number; readonly index: number; readonly edit: (label: string, f: (e: Edid) => Edid) => void }) {
  const b = dataBlockAt(edid, { type: "dataBlock", extension, index });
  if (!b) return null;
  const remove = (
    <div className="row">
      <button className="btn small danger" onClick={() => edit(`Remove ${nodeLabelFor(edid, extension, index)}`, (e) => removeDataBlock(e, extension, index))}>
        Remove this block
      </button>
    </div>
  );

  if (b.kind === "video") {
    let first = 0;
    edid.extensions.forEach((e, ei) => {
      if (e.kind === "cta") e.dataBlocks.forEach((x, bi) => {
        if (x.kind === "video" && (ei < extension || (ei === extension && bi < index))) first += x.svds.length;
      });
    });
    const y420 = y420Indexes(edid);
    return (
      <>
        <table className="modes">
          <thead>
            <tr>
              <th>VIC</th>
              <th>Mode</th>
              <th>Flags</th>
              <th>
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {b.svds.map((s, i) => {
              const v = lookupVic(s.vic);
              const is420 = y420 === "all" || (y420 !== null && y420.has(first + i));
              return (
                <tr key={`${i}:${s.vic}`}>
                  <td className="r mono">{s.vic}</td>
                  <td>{v ? modeLabel(v) : "unknown VIC"}</td>
                  <td>
                    {s.native && <span className="pill ok">native</span>} {is420 && <span className="pill">4:2:0</span>}
                  </td>
                  <td className="r">
                    <button className="btn small danger" aria-label={`Remove VIC ${s.vic}`} onClick={() => edit(`Remove VIC ${s.vic}${v ? ` (${modeLabel(v)})` : ""}`, (e) => removeSvd(e, extension, index, i))}>
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {remove}
      </>
    );
  }

  if (b.kind === "hdmiVsdb") {
    const pa = b.physicalAddress;
    const c = b.capabilities;
    return (
      <>
        <Fields
          rows={[
            ["Physical address", `${pa >> 12}.${(pa >> 8) & 15}.${(pa >> 4) & 15}.${pa & 15}`],
            ["Max TMDS clock", b.maxTmdsClock5MHz === undefined ? "not stated" : b.maxTmdsClock5MHz === 0 ? "not stated (0)" : `${b.maxTmdsClock5MHz * 5} MHz`],
          ]}
        />
        {c && (
          <>
            <div className="sub">Deep colour (RGB and 4:4:4)</div>
            <div className="checks">
              <Check label="10-bit" checked={c.dc30bit} onChange={(v) => edit(`${v ? "Allow" : "Remove"} 10-bit deep colour`, (e) => setHdmiDeepColour(e, { dc30bit: v }))} />
              <Check label="12-bit" checked={c.dc36bit} onChange={(v) => edit(`${v ? "Allow" : "Remove"} 12-bit deep colour`, (e) => setHdmiDeepColour(e, { dc36bit: v }))} />
              <Check label="16-bit" checked={c.dc48bit} onChange={(v) => edit(`${v ? "Allow" : "Remove"} 16-bit deep colour`, (e) => setHdmiDeepColour(e, { dc48bit: v }))} />
              <Check label="Also for YCbCr 4:4:4" checked={c.dcY444} onChange={(v) => edit(`${v ? "Allow" : "Remove"} deep colour for YCbCr 4:4:4`, (e) => setHdmiDeepColour(e, { dcY444: v }))} />
            </div>
          </>
        )}
        {remove}
      </>
    );
  }

  if (b.kind === "hdmiForumVsdb") {
    return (
      <>
        <Fields
          rows={[
            ["Max TMDS character rate", b.maxTmdsCharRate5MHz === 0 ? "340 MHz or less" : `${b.maxTmdsCharRate5MHz * 5} MHz`],
            ["SCDC", yesNo(b.scdcPresent)],
            ["Scrambling at 340 MHz or less", yesNo(b.lte340McscScramble)],
            ["Max FRL rate code", String(b.maxFrlRate)],
          ]}
        />
        <div className="sub">Deep colour for YCbCr 4:2:0</div>
        <div className="checks">
          <Check label="10-bit" checked={b.dc30bit420} onChange={(v) => edit(`${v ? "Allow" : "Remove"} 10-bit 4:2:0`, (e) => setHf420DeepColour(e, { dc30bit420: v }))} />
          <Check label="12-bit" checked={b.dc36bit420} onChange={(v) => edit(`${v ? "Allow" : "Remove"} 12-bit 4:2:0`, (e) => setHf420DeepColour(e, { dc36bit420: v }))} />
          <Check label="16-bit" checked={b.dc48bit420} onChange={(v) => edit(`${v ? "Allow" : "Remove"} 16-bit 4:2:0`, (e) => setHf420DeepColour(e, { dc48bit420: v }))} />
        </div>
        {remove}
      </>
    );
  }

  if (b.kind === "videoCapability") {
    return (
      <>
        <Fields rows={[["Selectable RGB range (QS)", yesNo(b.qs)], ["Selectable YCC range (QY)", yesNo(b.qy)]]} />
        {remove}
      </>
    );
  }

  if (b.kind === "ycbcr420Video") {
    return (
      <>
        <ul className="issues">
          {b.svds.map((s, i) => (
            <li key={i} className="info">
              VIC {s.vic}: {svdLabel(s.vic)}, 4:2:0 only
            </li>
          ))}
        </ul>
        {remove}
      </>
    );
  }

  return (
    <>
      <p className="note">{b.kind === "raw" ? "Kept byte for byte; not decoded or editable yet." : null}</p>
      {remove}
    </>
  );
}

function nodeLabelFor(edid: Edid, extension: number, index: number): string {
  const b = ctaAt(edid, extension)?.dataBlocks[index];
  if (!b) return "data block";
  return nodeLabel(edid, { id: "", ref: { type: "dataBlock", extension, index }, start: 0, end: 0, children: [] });
}
