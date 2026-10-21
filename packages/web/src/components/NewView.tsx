import { useState } from "react";
import { buildEdid, EdidEncodeError, EdidExportError, fallbackDtd, LINKS, serializeEdid, importEdid } from "@edid-studio/core";
import type { Depth, ImportedEdid, Link, TimingResult } from "@edid-studio/core";
import { DEFAULT_SEED, TimingEditor } from "./TimingEditor.tsx";

interface Props {
  readonly onCreated: (imported: ImportedEdid, fileName: string) => void;
}

const DEPTH_CHOICES: readonly Depth[] = [10, 12, 16];

/** The raster fallbackDtd() uses, for the explanation. */
const FALLBACK = { hActive: 1920, vActive: 1080 } as const;

export function NewView({ onCreated }: Props) {
  const [name, setName] = useState("LED wall");
  const [manufacturer, setManufacturer] = useState("VYV");
  const [product, setProduct] = useState("1");
  const [link, setLink] = useState<Link>("hdmi2.0");
  const [ycc444, setYcc444] = useState(false);
  const [ycc422, setYcc422] = useState(false);
  const [depths, setDepths] = useState<readonly Depth[]>([8, 10]);
  const [with640, setWith640] = useState(false);
  const [timing, setTiming] = useState<TimingResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dvi = link === "dvi";
  const create = () => {
    setError(null);
    if (!timing || (!timing.dtd && !timing.displayId)) {
      setError("Fix the timing first: it must fit a detailed timing descriptor or a DisplayID timing.");
      return;
    }
    const productCode = Number(product);
    if (!/^\d+$/.test(product) || productCode > 0xffff) {
      setError("Product code must be a whole number from 0 to 65535.");
      return;
    }
    try {
      // A raster a DTD cannot hold goes in a DisplayID block, with a fallback DTD in the base block.
      const baseTiming = timing.dtd ?? fallbackDtd(timing.request.refresh);
      const edid = buildEdid({
        name,
        manufacturerId: manufacturer.toUpperCase(),
        productCode,
        year: new Date().getFullYear(),
        timing: baseTiming,
        ...(timing.dtd || !timing.displayId ? {} : { displayIdTimings: [timing.displayId] }),
        link,
        formats: dvi ? ["rgb"] : ["rgb", ...(ycc444 ? (["ycbcr444"] as const) : []), ...(ycc422 ? (["ycbcr422"] as const) : [])],
        depths: dvi ? [8] : depths,
        include640x480: with640,
      });
      // Re-import the serialized bytes so the session starts from exactly what will be exported.
      const imported = importEdid(serializeEdid(edid));
      const safeName = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "edid";
      onCreated(imported, `${safeName} (new)`);
    } catch (e) {
      setError(e instanceof EdidEncodeError || e instanceof EdidExportError ? e.message : "The EDID could not be built.");
    }
  };

  return (
    <section aria-labelledby="new-title">
      <div className="eyebrow">New EDID</div>
      <h2 id="new-title" className="hero">
        Build the EDID you want
      </h2>
      <p className="lede">
        Give the raster, refresh, colour format and bit depth. EDID Studio builds an EDID that advertises exactly that
        and nothing else, so the source has no other mode to fall back to.
      </p>

      <div className="new-grid">
        <div className="card">
          <h2 className="section">Resolution and timing</h2>
          <TimingEditor seed={DEFAULT_SEED} link={link} onResult={setTiming} />
          {timing && !timing.dtd && (
            <p className="hint">
              This raster is too large for a detailed timing descriptor, so it goes in a DisplayID extension block as the preferred
              timing. The base block keeps {FALLBACK.hActive}x{FALLBACK.vActive} at the same refresh for sources that ignore
              DisplayID.{link.startsWith("hdmi") ? " An HDMI Forum EEODB in the CTA block tells sources there is a third block." : ""}
            </p>
          )}
        </div>

        <div className="stack">
          <div className="card">
            <h2 className="section">Identity</h2>
            <div className="form">
              <label className="full">
                Monitor name (up to 13 characters)
                <input value={name} maxLength={13} onChange={(e) => setName(e.target.value)} spellCheck={false} />
              </label>
              <label>
                Manufacturer ID (3 letters)
                <input value={manufacturer} maxLength={3} onChange={(e) => setManufacturer(e.target.value)} spellCheck={false} />
              </label>
              <label>
                Product code
                <input inputMode="numeric" value={product} onChange={(e) => setProduct(e.target.value)} />
              </label>
            </div>
          </div>

          <div className="card">
            <h2 className="section">Link and colour</h2>
            <div className="form">
              <label className="full">
                Link
                <select value={link} onChange={(e) => setLink(e.target.value as Link)}>
                  {(Object.keys(LINKS) as Link[]).map((l) => (
                    <option key={l} value={l}>
                      {LINKS[l].name} ({LINKS[l].limitLabel})
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="sub">Colour formats</div>
            <div className="checks">
              <label>
                <input type="checkbox" checked disabled /> RGB (always)
              </label>
              <label>
                <input type="checkbox" disabled={dvi} checked={!dvi && ycc444} onChange={(e) => setYcc444(e.target.checked)} /> YCbCr 4:4:4
              </label>
              <label>
                <input type="checkbox" disabled={dvi} checked={!dvi && ycc422} onChange={(e) => setYcc422(e.target.checked)} /> YCbCr 4:2:2
              </label>
            </div>
            <div className="sub">Bit depths</div>
            <div className="checks">
              <label>
                <input type="checkbox" checked disabled /> 8-bit (always)
              </label>
              {DEPTH_CHOICES.map((d) => (
                <label key={d}>
                  <input
                    type="checkbox"
                    disabled={dvi}
                    checked={!dvi && depths.includes(d)}
                    onChange={(e) => setDepths((cur) => (e.target.checked ? [...cur, d] : cur.filter((x) => x !== d)).sort((a, b) => a - b))}
                  />{" "}
                  {d}-bit
                </label>
              ))}
            </div>
            <p className="hint">
              Only tick what you want the GPU to use. Unticked depths are not advertised, so the driver cannot pick them. 4:2:0 applies only to
              standard VIC modes, not to a custom timing.
            </p>
            {LINKS[link].kind === "dp" && (
              <p className="hint">
                DisplayPort sinks use EDID 1.4: the bit depth and YCbCr support go in the base block, which names the DisplayPort interface. There
                is no CTA block and no HDMI block.
              </p>
            )}
          </div>

          <div className="card">
            <h2 className="section">Other modes</h2>
            <div className="checks">
              <label>
                <input type="checkbox" checked={with640} onChange={(e) => setWith640(e.target.checked)} /> Also list 640x480 @ 60 Hz
              </label>
            </div>
            <p className="hint">
              Off by default, so the EDID holds your timing and nothing else. CTA-861 expects 640x480 and edid-decode reports its absence as a
              failure; turn it on if a source or processor refuses the EDID without it.
            </p>
          </div>

          <div className="card">
            <button className="btn primary" onClick={create} disabled={!timing}>
              Create EDID
            </button>
            {error !== null && (
              <div className="alert" role="alert">
                <p>{error}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
