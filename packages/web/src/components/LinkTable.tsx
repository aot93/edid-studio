import { DEPTHS, feasibility, FORMAT_NAMES, FORMATS, LINKS } from "@edid-studio/core";
import type { Feasibility, Link } from "@edid-studio/core";

interface Props {
  readonly pixelClockKHz: number;
  readonly link: Link;
  /** Cells the EDID advertises, outlined. */
  readonly advertised?: readonly Feasibility[];
  /** The likely driver choice, marked. */
  readonly likely?: Feasibility | undefined;
}

/** Format x depth grid: the TMDS rate each needs and whether it fits the link (SPEC.md section 7). */
export function LinkTable({ pixelClockKHz, link, advertised, likely }: Props) {
  const rows = feasibility(pixelClockKHz, link);
  return (
    <table className="linktable">
      <caption>
        {LINKS[link].name}: limit {LINKS[link].limitLabel}. Rates include blanking.
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
                  title={`${(r.rateKHz / 1000).toFixed(2)} MHz ${r.fits ? "fits" : "exceeds the limit"}${adv ? ", advertised" : ""}${pick ? ", likely choice" : ""}`}
                >
                  {(r.rateKHz / 1000).toFixed(1)}
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
