import { DEPTHS, feasibility, FORMAT_NAMES, FORMATS, LINKS } from "@edid-studio/core";
import type { Feasibility, Link, TimingGeometry } from "@edid-studio/core";

interface Props {
  readonly pixelClockKHz: number;
  readonly link: Link;
  /** The timing's shape, which FRL uses; without it FRL needs are slightly overstated. */
  readonly geometry?: TimingGeometry | undefined;
  /** Cells the EDID advertises, outlined. */
  readonly advertised?: readonly Feasibility[];
  /** The likely driver choice, marked. */
  readonly likely?: Feasibility | undefined;
}

/** Format x depth grid: the TMDS rate each needs and whether it fits the link (SPEC.md section 7). */
export function LinkTable({ pixelClockKHz, link, geometry, advertised, likely }: Props) {
  const rows = feasibility(pixelClockKHz, link, geometry);
  return (
    <table className="linktable">
      <caption>
        {LINKS[link].name}: limit {LINKS[link].limitLabel}. Rates include blanking.
        {link === "hdmi2.1" && " Above 600 MHz TMDS a cell shows the FRL rate it needs (model from Glenwing's display guide; the HDMI 2.1 spec is not public)."}
      </caption>
      <thead>
        <tr>
          <th scope="col">Format</th>
          {DEPTHS.map((d) => (
            <th key={d} scope="col" className="r">
              {d}-bit
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {FORMATS.map((f) => (
          <tr key={f}>
            <th scope="row">{FORMAT_NAMES[f]}</th>
            {DEPTHS.map((d) => {
              const r = rows.find((x) => x.format === f && x.depth === d);
              if (!r) return <td key={d} />;
              if (r.unsupported) {
                return (
                  <td key={d} className="r na" title={r.unsupported}>
                    –
                  </td>
                );
              }
              const adv = advertised?.some((a) => a.format === f && a.depth === d) ?? false;
              const pick = likely?.format === f && likely.depth === d;
              return (
                <td
                  key={d}
                  className={`r ${r.fits ? "fit" : "over"}${adv ? " adv" : ""}${pick ? " likely" : ""}`}
                  title={`${r.kbps !== undefined ? `${(r.kbps / 1_000_000).toFixed(2)} Gbps${r.frl ? ` over FRL ${r.frl.gbpsPerLane} Gbps x ${r.frl.lanes}` : ""}` : `${(r.rateKHz / 1000).toFixed(2)} MHz`} ${r.fits ? "fits" : "exceeds the limit"}${adv ? ", advertised" : ""}${pick ? ", likely choice" : ""}`}
                >
                  {r.frl ? `FRL ${r.frl.gbpsPerLane}x${r.frl.lanes}` : r.kbps !== undefined ? `${(r.kbps / 1_000_000).toFixed(1)}G` : (r.rateKHz / 1000).toFixed(1)}
                  <span className="sr-only">
                    {r.fits ? " fits" : " too fast"}
                    {adv ? ", advertised" : ""}
                    {pick ? ", likely choice" : ""}
                  </span>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
