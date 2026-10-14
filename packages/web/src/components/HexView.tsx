import { memo } from "react";
import type { ByteDiff, LayoutNode } from "@edid-studio/core";
import { hex } from "../model-view.ts";

interface Props {
  readonly bytes: Uint8Array;
  readonly diff: ByteDiff;
  readonly blockLabels: readonly string[];
  readonly selected: LayoutNode | undefined;
  readonly hovered: LayoutNode | null;
  readonly onPick: (offset: number) => void;
}

export const HexView = memo(function HexView({ bytes, diff, blockLabels, selected, hovered, onPick }: Props) {
  const inRange = (n: LayoutNode | null | undefined, i: number) => n != null && i >= n.start && i < n.end;
  const rows: number[] = [];
  for (let i = 0; i < bytes.length; i += 16) rows.push(i);

  return (
    <section className="card" aria-labelledby="hex-title">
      <h2 className="section" id="hex-title">
        Bytes
      </h2>
      <div className="hex" role="grid" aria-label={`${bytes.length} bytes`}>
        {rows.map((row) => (
          <div key={row}>
            {row % 128 === 0 && <div className="bh">{blockLabels[row / 128]}</div>}
            <div className="line" role="row">
              <span className="off" aria-hidden="true">
                {hex(row % 128)}
              </span>
              {Array.from(bytes.subarray(row, row + 16), (b, j) => {
                const i = row + j;
                const cls = [
                  "b",
                  b === 0 ? "zero" : "",
                  inRange(selected, i) ? "sel" : inRange(hovered, i) ? "hl" : "",
                  diff.changed[i] ? "chg" : "",
                ].join(" ");
                return (
                  <span
                    key={i}
                    role="gridcell"
                    className={cls}
                    title={`offset ${i} (0x${hex(i, 3)})${diff.changed[i] ? ", new or changed since import" : ""}`}
                    onClick={() => onPick(i)}
                  >
                    {hex(b)}
                  </span>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="legend">
        <span>
          <i className="l-sel" />
          selected
        </span>
        <span>
          <i className="l-chg" />
          new or changed since import: {diff.added} {diff.added === 1 ? "byte" : "bytes"}
          {diff.removed > 0 ? `, ${diff.removed} removed` : ""}
        </span>
      </div>
    </section>
  );
});
