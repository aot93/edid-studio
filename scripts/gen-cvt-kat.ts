// Generates CVT known-answer data from edid-decode --cvt (SPEC.md section 6:
// "generate known-answer tests from the cvt and gtf utilities and
// edid-decode"). Usage: node scripts/gen-cvt-kat.ts <path/to/edid-decode>

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { argv } from "node:process";

const bin = argv[2];
if (bin === undefined) throw new Error("usage: gen-cvt-kat.ts <edid-decode>");

const modes: [number, number, number][] = [
  [1024, 768, 60], [1280, 720, 60], [1280, 1024, 75], [1920, 1080, 50], [1920, 1080, 60], [1920, 1200, 60],
  [2560, 1080, 60], [2560, 1440, 60], [2688, 1536, 50], [3840, 1080, 50], [3840, 1080, 60], [3840, 2160, 24],
  [3840, 2160, 25], [3840, 2160, 30], [3840, 2160, 50], [3840, 2160, 60], [4096, 2160, 50], [7680, 1080, 50],
  [1920, 1080, 120], [1600, 900, 60],
];

const rows: unknown[] = [];
for (const [w, h, fps] of modes) {
  for (const rb of [0, 1, 2]) {
    const out = execFileSync(bin, ["--cvt", `w=${w},h=${h},fps=${fps},rb=${rb}`], { encoding: "utf8" });
    const m = /CVT:\s+(\d+)x(\d+)\s+([\d.]+) Hz.*?([\d.]+) MHz.*\n\s+Hfront\s+(\d+) Hsync\s+(\d+) Hback\s+(\d+) Hpol ([PN])\n\s+Vfront\s+(\d+) Vsync\s+(\d+) Vback\s+(\d+) Vpol ([PN])/.exec(out);
    if (!m) throw new Error(`unparsed output for ${w}x${h}@${fps} rb=${rb}:\n${out}`);
    rows.push({
      w, h, fps, rb,
      clockKHz: Math.round(Number(m[4]) * 1000),
      hFrontPorch: Number(m[5]), hSync: Number(m[6]), hBackPorch: Number(m[7]), hSyncPositive: m[8] === "P",
      vFrontPorch: Number(m[9]), vSync: Number(m[10]), vBackPorch: Number(m[11]), vSyncPositive: m[12] === "P",
    });
  }
}
writeFileSync(
  new URL("../packages/edid-core/test/data/cvt-kat.json", import.meta.url),
  JSON.stringify({ source: "edid-decode --cvt (v4l-utils c6600a7e)", rows }, null, 1) + "\n",
);
console.log(`wrote ${rows.length} rows`);
