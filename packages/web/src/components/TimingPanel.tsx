import { useState } from "react";
import {
  addDetailedTiming,
  addDisplayIdTiming,
  autoRangeLimits,
  describeDisplayIdTiming,
  describeDtd,
  keepOnlyModes,
  modeLabel,
  replaceDescriptor,
  setPreferredTiming,
  setRangeLimits,
} from "@edid-studio/core";
import type { Edid, Link, TimingResult } from "@edid-studio/core";
import type { EditFn, TimingTarget } from "./Inspector.tsx";
import { DEFAULT_SEED, seedFromDtd, TimingEditor } from "./TimingEditor.tsx";

interface Props {
  readonly target: TimingTarget;
  readonly link: Link;
  readonly onEdit: EditFn;
  readonly onClose: () => void;
}

/** Range limits follow the modes when the EDID already has a range limits descriptor. */
function refitRanges(e: Edid): Edid {
  if (!e.base.descriptors.some((d) => d.kind === "rangeLimits")) return e;
  const spec = autoRangeLimits(e, e.base.revision >= 4 ? "none" : "default");
  return spec ? setRangeLimits(e, spec) : e;
}

export function TimingPanel({ target, link, onEdit, onClose }: Props) {
  const [result, setResult] = useState<TimingResult | null>(null);
  const [stripOthers, setStripOthers] = useState(true);
  const [fitRanges, setFitRanges] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const dtd = result?.dtd;
  // Only offered when the raster does not fit a DTD, which sources support more widely.
  const displayId = dtd ? undefined : result?.displayId;
  const label = dtd ? modeLabel(describeDtd(dtd)) : displayId ? modeLabel(describeDisplayIdTiming(displayId)) : "";

  const apply = (what: string, f: (e: Edid) => Edid) => {
    const err = onEdit(what, (e) => (fitRanges ? refitRanges(f(e)) : f(e)));
    if (err === null) onClose();
    else setError(err);
  };

  return (
    <section className="card timing-panel" aria-labelledby="tp-title">
      <h2 className="section" id="tp-title">
        {target.mode === "replace" ? "Edit timing" : "Custom resolution"}
      </h2>
      <TimingEditor seed={target.mode === "replace" ? seedFromDtd(target.dtd) : DEFAULT_SEED} link={link} onResult={setResult} />
      <div className="actions">
        {target.mode === "replace" ? (
          <button className="btn primary" disabled={!dtd} onClick={() => dtd && apply(`Change timing to ${label}`, (e) => replaceDescriptor(e, target.where, dtd))}>
            Replace timing
          </button>
        ) : (
          <>
            <button
              className="btn primary"
              disabled={!dtd}
              onClick={() =>
                dtd && apply(`${stripOthers ? "Keep only" : "Set preferred timing"} ${label}`, (e) => setPreferredTiming(stripOthers ? keepOnlyModes(e) : e, dtd))
              }
            >
              Set as preferred timing
            </button>
            <label>
              <input type="checkbox" checked={stripOthers} onChange={(e) => setStripOthers(e.target.checked)} />
              remove every other mode (VICs, standard, established, HDMI VICs)
            </label>
            <button className="btn" disabled={!dtd} onClick={() => dtd && apply(`Add timing ${label}`, (e) => addDetailedTiming(e, dtd))}>
              Add as an extra timing
            </button>
            {displayId && (
              <button className="btn primary" onClick={() => apply(`Add DisplayID timing ${label}`, (e) => addDisplayIdTiming(e, displayId))}>
                Add as preferred DisplayID timing
              </button>
            )}
          </>
        )}
        <label>
          <input type="checkbox" checked={fitRanges} onChange={(e) => setFitRanges(e.target.checked)} />
          fit range limits to the modes
        </label>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
      {displayId && (
        <p className="hint">
          {target.mode === "replace"
            ? "This raster does not fit a detailed timing descriptor, so it cannot replace one. Add it as a DisplayID timing instead."
            : "This raster does not fit a detailed timing descriptor. It goes in a DisplayID extension block; the existing preferred timing stays for sources that ignore DisplayID."}
        </p>
      )}
      {error !== null && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
