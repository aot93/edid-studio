import { useEffect, useId, useMemo, useState } from "react";
import { buildTiming, describeDtd, EdidEncodeError, FORMULA_NAMES, fmtMHz } from "@edid-studio/core";
import type { DetailedTimingDescriptor, Formula, Link, TimingResult } from "@edid-studio/core";
import { LinkTable } from "./LinkTable.tsx";

const PORCHES = [
  ["hFrontPorch", "H front porch"],
  ["hSync", "H sync"],
  ["hBackPorch", "H back porch"],
  ["vFrontPorch", "V front porch"],
  ["vSync", "V sync"],
  ["vBackPorch", "V back porch"],
] as const;
type PorchKey = (typeof PORCHES)[number][0];

export interface TimingSeed {
  readonly width: string;
  readonly height: string;
  readonly refresh: string;
  readonly formula: Formula;
  readonly porches?: Record<PorchKey, string>;
  readonly hPos?: boolean;
  readonly vPos?: boolean;
}

export const DEFAULT_SEED: TimingSeed = { width: "3840", height: "2160", refresh: "50", formula: "exact" };

/** Seeds the editor from an existing DTD as manual porches, with its exact refresh as a fraction. */
export function seedFromDtd(d: DetailedTimingDescriptor): TimingSeed {
  const info = describeDtd(d);
  const num = d.pixelClock10kHz * 10_000;
  const den = info.hTotal * info.vTotal;
  const g = gcd(num, den);
  return {
    width: String(d.hActive),
    height: String(d.vActive),
    refresh: den / g === 1 ? String(num / g) : `${num / g}/${den / g}`,
    formula: "manual",
    porches: {
      hFrontPorch: String(d.hFrontPorch),
      hSync: String(d.hSync),
      hBackPorch: String(info.hBackPorch),
      vFrontPorch: String(d.vFrontPorch),
      vSync: String(d.vSync),
      vBackPorch: String(info.vBackPorch),
    },
    hPos: info.hSyncPositive,
    vPos: info.vSyncPositive,
  };
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

const int = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : NaN);

interface Props {
  readonly seed: TimingSeed;
  readonly link: Link;
  readonly onResult: (r: TimingResult | null) => void;
}

export function TimingEditor({ seed, link, onResult }: Props) {
  const id = useId();
  const [width, setWidth] = useState(seed.width);
  const [height, setHeight] = useState(seed.height);
  const [refresh, setRefresh] = useState(seed.refresh);
  const [formula, setFormula] = useState<Formula>(seed.formula);
  const [porches, setPorches] = useState<Record<PorchKey, string> | undefined>(seed.porches);
  const [hPos, setHPos] = useState<boolean | undefined>(seed.hPos);
  const [vPos, setVPos] = useState<boolean | undefined>(seed.vPos);

  const outcome = useMemo((): { result: TimingResult } | { error: string } => {
    try {
      const p = porches && formula === "manual" ? Object.fromEntries(PORCHES.map(([k]) => [k, int(porches[k])])) : undefined;
      if (p && Object.values(p).some((v) => Number.isNaN(v))) return { error: "Porches and sync widths must be whole numbers." };
      const result = buildTiming({
        hActive: int(width),
        vActive: int(height),
        refresh,
        formula,
        ...(p ? { porches: p as Record<PorchKey, number> } : {}),
        ...(hPos === undefined ? {} : { hSyncPositive: hPos }),
        ...(vPos === undefined ? {} : { vSyncPositive: vPos }),
      });
      return { result };
    } catch (e) {
      return { error: e instanceof EdidEncodeError ? e.message : "Enter a width, height and refresh rate." };
    }
  }, [width, height, refresh, formula, porches, hPos, vPos]);

  const result = "result" in outcome ? outcome.result : null;
  // A timing is usable when it fits a DTD, or failing that a DisplayID Type I timing.
  useEffect(() => onResult(result?.dtd || result?.displayId ? result : null), [result, onResult]);

  const switchFormula = (f: Formula) => {
    // Switching to manual starts from the porches currently shown.
    if (f === "manual" && result) {
      const t = result.timing;
      setPorches(Object.fromEntries(PORCHES.map(([k]) => [k, String(t[k])])) as Record<PorchKey, string>);
      setHPos(t.hSyncPositive);
      setVPos(t.vSyncPositive);
    }
    if (f !== "manual") {
      setHPos(undefined);
      setVPos(undefined);
    }
    setFormula(f);
  };

  const shown = result?.timing;
  return (
    <div className="timing">
      <div className="tgrid">
        <label>
          Width
          <input inputMode="numeric" value={width} onChange={(e) => setWidth(e.target.value)} />
        </label>
        <label>
          Height
          <input inputMode="numeric" value={height} onChange={(e) => setHeight(e.target.value)} />
        </label>
        <label>
          Refresh (Hz)
          <input value={refresh} onChange={(e) => setRefresh(e.target.value)} aria-describedby={`${id}-rhelp`} />
        </label>
        <label className="wide">
          Formula
          <select value={formula} onChange={(e) => switchFormula(e.target.value as Formula)}>
            {(Object.keys(FORMULA_NAMES) as Formula[]).map((f) => (
              <option key={f} value={f}>
                {FORMULA_NAMES[f]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="hint" id={`${id}-rhelp`}>
        Refresh accepts 50, 59.94 or an exact fraction such as 60000/1001.
      </p>

      <div className="tgrid porches">
        {PORCHES.map(([k, label]) => (
          <label key={k}>
            {label}
            <input
              inputMode="numeric"
              readOnly={formula !== "manual"}
              value={formula === "manual" && porches ? porches[k] : shown ? String(shown[k]) : ""}
              onChange={(e) => porches && setPorches({ ...porches, [k]: e.target.value })}
            />
          </label>
        ))}
        <label>
          H sync polarity
          <select
            disabled={formula !== "manual"}
            value={(formula === "manual" ? hPos : shown?.hSyncPositive) ? "+" : "-"}
            onChange={(e) => setHPos(e.target.value === "+")}
          >
            <option value="+">positive</option>
            <option value="-">negative</option>
          </select>
        </label>
        <label>
          V sync polarity
          <select
            disabled={formula !== "manual"}
            value={(formula === "manual" ? vPos : shown?.vSyncPositive) ? "+" : "-"}
            onChange={(e) => setVPos(e.target.value === "+")}
          >
            <option value="+">positive</option>
            <option value="-">negative</option>
          </select>
        </label>
      </div>
      {formula !== "manual" && (
        <p className="hint">
          Porches come from the formula. Choose Manual porches to edit them; it starts from these values.
        </p>
      )}

      {"error" in outcome ? (
        <div className="alert" role="alert">
          <p>{outcome.error}</p>
        </div>
      ) : (
        result && (
          <>
            <div className="tresult">
              <div className="kf">
                <div className="n">{fmtMHz(result.timing.pixelClock10kHz * 10)}</div>
                <div className="l">
                  pixel clock · total {result.timing.hTotal} x {result.timing.vTotal}
                </div>
              </div>
              <div className="kf">
                <div className="n">{result.achievedHz.toFixed(6)} Hz</div>
                <div className="l">
                  {result.exact ? (
                    <span className="pill ok">exact</span>
                  ) : (
                    <>
                      {result.errorPpm >= 0 ? "+" : ""}
                      {result.errorPpm.toFixed(1)} ppm from {result.targetHz.toFixed(6)} Hz
                    </>
                  )}
                </div>
              </div>
              <div className="kf">
                <div className="n">{result.dtd ? "Fits a DTD" : result.displayId ? "DisplayID timing" : "Too large"}</div>
                <div className="l">
                  {(result.timing.hTotal - result.timing.hActive).toString()} px H blank · {(result.timing.vTotal - result.timing.vActive).toString()} lines V blank
                  {result.encodings.vics.length > 0 && ` · VIC ${result.encodings.vics.join(", ")}`}
                  {result.encodings.dmts.length > 0 && ` · DMT ${result.encodings.dmts.map((d) => `0x${d.toString(16).padStart(2, "0")}`).join(", ")}`}
                </div>
              </div>
            </div>
            {(result.dtdProblems.length > 0 || result.notes.length > 0) && (
              <ul className="issues">
                {result.dtdProblems.map((p) => (
                  <li key={p} className={result.displayId ? "warning" : "error"}>
                    {result.displayId ? `Not a DTD: ${p}` : p}
                  </li>
                ))}
                {!result.dtd &&
                  result.displayIdProblems.map((p) => (
                    <li key={`displayid-${p}`} className="error">
                      DisplayID: {p}
                    </li>
                  ))}
                {result.notes.map((n) => (
                  <li key={n} className="warning">
                    {n}
                  </li>
                ))}
              </ul>
            )}
            <LinkTable pixelClockKHz={result.timing.pixelClock10kHz * 10} link={link} geometry={result.timing} />
          </>
        )
      )}
    </div>
  );
}
