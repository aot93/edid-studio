// A plain-text report of an EDID, for `edidtool decode` (SPEC.md section 12).
// EDID text is quoted through printable(); every other value is a number.

import { advertisedColour } from "./analyze.ts";
import { manufacturerId } from "./base-block.ts";
import { dataBlockName, modeLabels } from "./changes.ts";
import { describeDtd } from "./describe.ts";
import { describeDisplayIdTiming, preferredDisplayIdTiming } from "./displayid.ts";
import { serializeEdid } from "./edid.ts";
import { FORMAT_NAMES } from "./link.ts";
import type { DtdInfo } from "./describe.ts";
import type { Edid } from "./model.ts";
import { printable } from "./safety.ts";

const yesNo = (v: boolean) => (v ? "yes" : "no");

function timingLines(label: string, i: DtdInfo, h: [number, number], v: [number, number], suffix = ""): string[] {
  return [
    `${label}: ${i.hActive}x${i.vActive}${i.interlaced ? "i" : ""} @ ${i.refreshHz.toFixed(3)} Hz, ${(i.pixelClockKHz / 1000).toFixed(2)} MHz, total ${i.hTotal} x ${i.vTotal}${suffix}`,
    `  H front/sync/back ${h[0]}/${h[1]}/${i.hBackPorch}, ${i.hSyncPositive ? "positive" : "negative"}; V ${v[0]}/${v[1]}/${i.vBackPorch}, ${i.vSyncPositive ? "positive" : "negative"}`,
  ];
}

/** One line per fact, in reading order. */
export function describeEdid(edid: Edid): string[] {
  const out: string[] = [];
  const b = edid.base;
  const kinds = edid.extensions.map((e) =>
    e.kind === "cta" ? "CTA-861" : e.kind === "displayid" ? `DisplayID ${e.version >> 4}.${e.version & 0xf}` : `extension 0x${(e.bytes[0] ?? 0).toString(16).padStart(2, "0")} (kept raw)`,
  );
  out.push(`EDID ${b.version}.${b.revision}, ${serializeEdid(edid).length} bytes: ${["base block", ...kinds].join(", ")}`);
  const name = b.descriptors.find((d) => d.kind === "text" && d.tag === 0xfc);
  const serialText = b.descriptors.find((d) => d.kind === "text" && d.tag === 0xff);
  out.push(
    `Manufacturer ${manufacturerId(b.manufacturerCode)}, product 0x${b.productCode.toString(16).padStart(4, "0")}, serial ${b.serialNumber}` +
      `${serialText?.kind === "text" ? ` ("${printable(serialText.text, 13)}")` : ""}, ${b.week === 0xff ? "model year" : "made"} ${b.yearOffset + 1990}${b.week > 0 && b.week < 0xff ? ` week ${b.week}` : ""}`,
  );
  out.push(`Name: ${name?.kind === "text" ? `"${printable(name.text, 13)}"` : "none"}`);
  out.push(
    `Input: ${b.videoInput & 0x80 ? "digital" : "analog"}; screen ${b.screenSize[0] && b.screenSize[1] ? `${b.screenSize[0]} x ${b.screenSize[1]} cm` : "size unspecified"}; gamma ${b.gamma === 0xff ? "elsewhere" : ((b.gamma + 100) / 100).toFixed(2)}`,
  );

  const id = preferredDisplayIdTiming(edid);
  const first = b.descriptors[0];
  if (id) out.push(...timingLines("Preferred timing", describeDisplayIdTiming(id), [id.hFrontPorch, id.hSync], [id.vFrontPorch, id.vSync], " (DisplayID)"));
  if (first?.kind === "dtd") out.push(...timingLines(id ? "Base block timing" : "Preferred timing", describeDtd(first), [first.hFrontPorch, first.hSync], [first.vFrontPorch, first.vSync]));
  if (!id && first?.kind !== "dtd") out.push("Preferred timing: none");

  const modes = modeLabels(edid);
  out.push(`Modes (${modes.length}):`, ...modes.map((m) => `  ${m}`));

  const r = b.descriptors.find((d) => d.kind === "rangeLimits");
  out.push(`Range limits: ${r?.kind === "rangeLimits" ? `${r.minVerticalHz}-${r.maxVerticalHz} Hz, ${r.minHorizontalKHz}-${r.maxHorizontalKHz} kHz, ${r.maxPixelClock10MHz * 10} MHz` : "none"}`);

  const adv = advertisedColour(edid);
  const deep = adv.depths.filter((d) => d > 8);
  out.push(`Colour: ${adv.formats.map((f) => FORMAT_NAMES[f]).join(", ")}; deep colour ${deep.length > 0 ? `${deep.join(", ")}-bit` : "none"}`);

  for (const e of edid.extensions) {
    if (e.kind === "cta") {
      out.push(`CTA-861: underscan ${yesNo(e.underscan)}, basic audio ${yesNo(e.basicAudio)}, YCbCr 4:4:4 ${yesNo(e.ycbcr444)}, 4:2:2 ${yesNo(e.ycbcr422)}`);
      for (const d of e.dataBlocks) {
        if (d.kind === "hdmiVsdb") {
          const pa = [12, 8, 4, 0].map((s) => (d.physicalAddress >> s) & 0xf).join(".");
          out.push(`  HDMI VSDB: physical address ${pa}, max TMDS ${d.maxTmdsClock5MHz !== undefined ? `${d.maxTmdsClock5MHz * 5} MHz` : "not stated"}`);
        } else if (d.kind === "hdmiForumVsdb") {
          out.push(`  HDMI Forum VSDB: max TMDS ${d.maxTmdsCharRate5MHz === 0 ? "340 MHz or less" : `${d.maxTmdsCharRate5MHz * 5} MHz`}, SCDC ${yesNo(d.scdcPresent)}`);
        } else {
          out.push(`  ${dataBlockName(d)[0]?.toUpperCase()}${dataBlockName(d).slice(1)}`);
        }
      }
    } else if (e.kind === "displayid") {
      out.push(`DisplayID ${e.version >> 4}.${e.version & 0xf}: product type ${e.productType}, ${e.dataBlocks.length} data block${e.dataBlocks.length === 1 ? "" : "s"}`);
    }
  }
  return out;
}
