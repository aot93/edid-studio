import { useMemo } from "react";
import { analyzeLink, FORMAT_NAMES, LINKS } from "@edid-studio/core";
import type { Edid, Link } from "@edid-studio/core";
import { LinkTable } from "./LinkTable.tsx";

/**
 * Mode x format x depth for every advertised mode on the chosen link, with
 * the likely driver choice (SPEC.md section 7). Mode labels are generated
 * from numbers, never from EDID text.
 */
export function LinkBudget({ edid, link }: { readonly edid: Edid; readonly link: Link }) {
  const reports = useMemo(() => analyzeLink(edid, link), [edid, link]);
  return (
    <section className="card linkbudget" aria-labelledby="lb-title">
      <h2 className="section" id="lb-title">
        Link budget
      </h2>
      <p className="hint">
        Each advertised mode on {LINKS[link].name}. Outlined cells are what the EDID advertises. “Likely” is a heuristic, not a spec: RGB first, then
        4:4:4, 4:2:2 and 4:2:0, at the highest advertised depth that fits.
      </p>
      {reports.length === 0 ? (
        <p className="note">No mode with a known pixel clock is advertised.</p>
      ) : (
        <ul className="lb">
          {reports.map((r) => (
            <li key={r.mode}>
              <details>
                <summary>
                  <span className="lb-mode">{r.mode}</span>
                  <span className="lb-clock">{(r.pixelClockKHz / 1000).toFixed(2)} MHz</span>
                  {r.likely ? (
                    <span className="pill ok">
                      likely {r.likely.depth}-bit {FORMAT_NAMES[r.likely.format]}
                    </span>
                  ) : (
                    <span className="pill bad">nothing advertised fits</span>
                  )}
                </summary>
                <LinkTable pixelClockKHz={r.pixelClockKHz} link={link} geometry={r.geometry} advertised={r.advertised} likely={r.likely} />
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
