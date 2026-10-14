// Renders square favicons from design/vyv-logo.png (271 x 120) with Chromium:
// the logo centred on a transparent square. Usage, from packages/web:
//   PW_CHROMIUM_PATH=/path/to/chrome node scripts/gen-favicons.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const logo = readFileSync(new URL("../../../design/vyv-logo.png", import.meta.url)).toString("base64");
const executablePath = process.env.PW_CHROMIUM_PATH;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage();
for (const [size, name] of [[32, "favicon-32.png"], [64, "favicon-64.png"], [180, "apple-touch-icon.png"]]) {
  const dataUrl = await page.evaluate(
    async ({ logo, size }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${logo}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const ctx = c.getContext("2d");
      const pad = Math.round(size * 0.06);
      const w = size - 2 * pad;
      const h = Math.round((w * img.height) / img.width);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, pad, Math.round((size - h) / 2), w, h);
      return c.toDataURL("image/png");
    },
    { logo, size },
  );
  writeFileSync(new URL(`../public/${name}`, import.meta.url), Buffer.from(dataUrl.split(",")[1], "base64"));
  console.log(`wrote ${name}`);
}
await browser.close();
