import { useState } from "react";
import {
  autoRangeLimits,
  decodeStandardTiming,
  encodeStandardTiming,
  EdidEncodeError,
  ESTABLISHED_TIMINGS,
  isEstablishedSet,
  setColor,
  setEstablishedTimings,
  setRangeLimits,
  setStandardTimings,
  standardTimingLabel,
  UNUSED_STANDARD_TIMING,
  advertisedColour,
} from "@edid-studio/core";
import type { ColourFormat, Depth, Edid, RangeLimitsDescriptor, StandardAspect } from "@edid-studio/core";

type Edit = (label: string, f: (e: Edid) => Edid) => void;

export function StandardTimingsEditor({ edid, edit }: { readonly edid: Edid; readonly edit: Edit }) {
  const [width, setWidth] = useState("1920");
  const [aspect, setAspect] = useState<StandardAspect>("16:9");
  const [refresh, setRefresh] = useState("60");
  const [error, setError] = useState<string | null>(null);
  const codes = edid.base.standardTimings;
  const free = codes.findIndex((c) => decodeStandardTiming(c) === undefined);

  const add = () => {
    try {
      const code = encodeStandardTiming({ hActive: Number(width), aspect, refreshHz: Number(refresh) });
      const t = decodeStandardTiming(code);
      setError(null);
      edit(`Add standard timing ${t ? standardTimingLabel(t) : ""}`, (e) => setStandardTimings(e, e.base.standardTimings.map((c, i) => (i === free ? code : c))));
    } catch (e) {
      setError(e instanceof EdidEncodeError ? e.message : "Invalid standard timing.");
    }
  };

  return (
    <>
      <p className="note">Eight two-byte slots. A source may pick any listed mode, so remove the ones you do not want.</p>
      <div>
        {codes.map((c, i) => {
          const t = decodeStandardTiming(c);
          return (
            <div key={i} className="std-row">
              <span className="n">{i + 1}</span>
              <span>{t ? standardTimingLabel(t) : <span className="muted">unused</span>}</span>
              {t ? (
                <button className="btn small danger" onClick={() => edit(`Remove standard timing ${standardTimingLabel(t)}`, (e) => setStandardTimings(e, e.base.standardTimings.map((x, j) => (j === i ? UNUSED_STANDARD_TIMING : x))))}>
                  Remove
                </button>
              ) : (
                <span />
              )}
            </div>
          );
        })}
      </div>
      <div className="sub">Add a standard timing</div>
      {free === -1 ? (
        <p className="note">All eight slots are in use.</p>
      ) : (
        <div className="form">
          <label>
            Width (256-2288, steps of 8)
            <input inputMode="numeric" value={width} onChange={(e) => setWidth(e.target.value)} />
          </label>
          <label>
            Aspect
            <select value={aspect} onChange={(e) => setAspect(e.target.value as StandardAspect)}>
              {(["16:9", "16:10", "4:3", "5:4"] as const).map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </label>
          <label>
            Refresh (60-123 Hz)
            <input inputMode="numeric" value={refresh} onChange={(e) => setRefresh(e.target.value)} />
          </label>
          <div className="full">
            <button className="btn small" onClick={add}>
              Add
            </button>
          </div>
        </div>
      )}
      <p className="hint">Standard timings cannot describe 4K or custom porches; use a detailed timing for those.</p>
      {error !== null && <p className="field-error">{error}</p>}
    </>
  );
}

export function EstablishedTimingsEditor({ edid, edit }: { readonly edid: Edid; readonly edit: Edit }) {
  const bytes = edid.base.establishedTimings;
  return (
    <>
      <p className="note">Legacy VESA modes, one bit each. CTA-861 expects 640x480 @ 60 Hz to stay.</p>
      <div className="checks">
        {ESTABLISHED_TIMINGS.map((t) => (
          <label key={t.label}>
            <input
              type="checkbox"
              checked={isEstablishedSet(bytes, t)}
              onChange={(e) => {
                const next = [...bytes] as [number, number, number];
                const i = t.byte - 0x23;
                next[i] = e.target.checked ? (next[i] ?? 0) | (1 << t.bit) : (next[i] ?? 0) & ~(1 << t.bit);
                edit(`${e.target.checked ? "Add" : "Remove"} established timing ${t.label}`, (x) => setEstablishedTimings(x, next));
              }}
            />
            {t.label}
          </label>
        ))}
      </div>
      <div className="row">
        <button className="btn small danger" onClick={() => edit("Remove all established timings", (x) => setEstablishedTimings(x, [0, 0, 0]))}>
          Clear all
        </button>
      </div>
    </>
  );
}

export function RangeLimitsEditor({ edid, d, edit }: { readonly edid: Edid; readonly d: RangeLimitsDescriptor; readonly edit: Edit }) {
  const [v, setV] = useState({
    vMin: String(d.minVerticalHz),
    vMax: String(d.maxVerticalHz),
    hMin: String(d.minHorizontalKHz),
    hMax: String(d.maxHorizontalKHz),
    clock: String(d.maxPixelClock10MHz * 10),
  });
  const [gtf, setGtf] = useState<"none" | "default">(d.timingSupport === 0x01 ? "none" : "default");
  const [error, setError] = useState<string | null>(null);
  const legacy = edid.base.revision < 4;

  const apply = () => {
    try {
      setError(null);
      const spec = { vHz: [Number(v.vMin), Number(v.vMax)] as const, hKHz: [Number(v.hMin), Number(v.hMax)] as const, maxClockMHz: Number(v.clock), gtf };
      setRangeLimits(edid, spec);
      edit(`Set range limits ${v.vMin}-${v.vMax} Hz, ${v.hMin}-${v.hMax} kHz, ${v.clock} MHz`, (e) => setRangeLimits(e, spec));
    } catch (e) {
      setError(e instanceof EdidEncodeError ? e.message : "Invalid range limits.");
    }
  };
  const auto = () => {
    const spec = autoRangeLimits(edid, gtf);
    if (!spec) {
      setError("There are no modes to cover yet.");
      return;
    }
    edit(`Set range limits from modes: ${spec.vHz.join("-")} Hz, ${spec.hKHz.join("-")} kHz, ${spec.maxClockMHz} MHz`, (e) => setRangeLimits(e, spec));
  };
  const field = (k: keyof typeof v, label: string) => (
    <label>
      {label}
      <input inputMode="numeric" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
    </label>
  );

  return (
    <>
      <div className="form">
        {field("vMin", "Min vertical (Hz)")}
        {field("vMax", "Max vertical (Hz)")}
        {field("hMin", "Min horizontal (kHz)")}
        {field("hMax", "Max horizontal (kHz)")}
        {field("clock", "Max pixel clock (MHz)")}
        <label>
          Timing formula
          <select value={gtf} onChange={(e) => setGtf(e.target.value as "none" | "default")}>
            <option value="default">Default GTF</option>
            <option value="none">Range limits only</option>
          </select>
        </label>
      </div>
      {legacy && gtf === "none" && <p className="hint">"Range limits only" is defined from EDID 1.4; NVIDIA accepted it in the Tessera case, but edid-decode flags it on 1.3.</p>}
      <div className="row">
        <button className="btn small" onClick={apply}>
          Apply
        </button>
        <button className="btn small" onClick={auto}>
          Fit to current modes
        </button>
      </div>
      {error !== null && <p className="field-error">{error}</p>}
    </>
  );
}

const FORMAT_CHOICES: readonly [ColourFormat, string][] = [
  ["ycbcr444", "YCbCr 4:4:4"],
  ["ycbcr422", "YCbCr 4:2:2"],
  ["ycbcr420", "YCbCr 4:2:0"],
];

/** Sets formats and depths together with setColor, so every block agrees. */
export function ColourForm({ edid, edit }: { readonly edid: Edid; readonly edit: Edit }) {
  const current = advertisedColour(edid);
  const [formats, setFormats] = useState<readonly ColourFormat[]>(current.formats);
  const [depths, setDepths] = useState<readonly Depth[]>(current.depths);
  const [error, setError] = useState<string | null>(null);
  const toggle = <T,>(list: readonly T[], v: T, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));

  return (
    <>
      <div className="sub">Colour formats</div>
      <div className="checks">
        <label>
          <input type="checkbox" checked disabled /> RGB
        </label>
        {FORMAT_CHOICES.map(([f, label]) => (
          <label key={f}>
            <input type="checkbox" checked={formats.includes(f)} onChange={(e) => setFormats(toggle(formats, f, e.target.checked))} /> {label}
          </label>
        ))}
      </div>
      <div className="sub">Bit depths</div>
      <div className="checks">
        <label>
          <input type="checkbox" checked disabled /> 8-bit
        </label>
        {([10, 12, 16] as const).map((d) => (
          <label key={d}>
            <input type="checkbox" checked={depths.includes(d)} onChange={(e) => setDepths(toggle(depths, d, e.target.checked))} /> {d}-bit
          </label>
        ))}
      </div>
      <p className="hint">Applies to the CTA flags, both HDMI blocks and the 4:2:0 blocks at once. Without 4:2:0, its blocks are removed.</p>
      <div className="row">
        <button
          className="btn small"
          onClick={() => {
            const f = [...new Set<ColourFormat>(["rgb", ...formats])];
            const d = [...new Set<Depth>([8, ...depths])].sort((a, b) => a - b);
            try {
              setError(null);
              edit(`Set colour: ${f.join(", ")}; ${d.map((x) => `${x}-bit`).join(", ")}`, (e) => setColor(e, f, d));
            } catch (e) {
              setError(e instanceof EdidEncodeError ? e.message : "Could not set colour.");
            }
          }}
        >
          Apply colour and depth
        </button>
      </div>
      {error !== null && <p className="field-error">{error}</p>}
    </>
  );
}
