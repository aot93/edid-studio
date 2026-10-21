import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// The edid-decode tests run when EDID_DECODE is set; default to the binary
// scripts/build-edid-decode.sh caches, if it has been built.
const cached = ".cache/edid-decode/edid-decode";
if (!process.env["EDID_DECODE"] && existsSync(cached)) process.env["EDID_DECODE"] = `${process.cwd()}/${cached}`;

export default defineConfig({
  test: { include: ["packages/*/test/**/*.test.ts"] },
});
