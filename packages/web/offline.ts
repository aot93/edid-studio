import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Plugin, Rolldown } from "vite";

type OutputAsset = Rolldown.OutputAsset;
type OutputChunk = Rolldown.OutputChunk;

/**
 * The offline build (`pnpm build:offline`): one self-contained HTML file for
 * workstations with no network, opened straight from disk in Firefox
 * (SPEC.md section 13, offline package). Everything is inlined, because a
 * page opened from disk cannot rely on loading files beside it: its origin
 * is opaque, Chromium refuses its module scripts, and fetch() of file:// fails.
 */
export const OFFLINE_FILE = "edid-studio.html";

/**
 * The offline CSP. Inline code is allowed only by hash, so it is as strict
 * as the hosted policy: nothing is loaded from anywhere. The owner approved
 * 'wasm-unsafe-eval' here (2026-11-06, offline build only) for the embedded
 * edid-decode WebAssembly; it is added with that build, not before.
 */
export function offlineCsp(scriptHash: string, styleHash: string): string {
  return [
    "default-src 'none'",
    `script-src '${scriptHash}'`,
    `style-src '${styleHash}'`,
    "font-src data:",
    "img-src data:",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

function sha256(text: string): string {
  return `sha256-${createHash("sha256").update(text, "utf8").digest("base64")}`;
}

/** Text inside <script> or <style> must not close its element early. */
function guardRawText(text: string, tag: "script" | "style"): string {
  // In JS, "<\/script" means the same as "</script" inside strings, regexes
  // and template literals, and comments do not matter.
  return tag === "script" ? text.replace(/<\/(script)/gi, "<\\/$1") : text.replace(/<\/(style)/gi, "<\\/$1");
}

/** Drops fontsource's WOFF fallback: every supported Firefox reads WOFF2. */
export function dropWoffFallback(css: string): string {
  return css.replace(/,\s*url\([^)]*\.woff\)\s*format\(['"]woff['"]\)/g, "");
}

function dataUri(file: URL, type: string): string {
  return `data:${type};base64,${readFileSync(file).toString("base64")}`;
}

export function offlineSingleFile(publicDir: URL): Plugin[] {
  const fonts: Plugin = {
    name: "edid-studio-offline-fonts",
    apply: "build",
    enforce: "pre",
    transform(code, id) {
      if (id.includes("@fontsource") && id.endsWith(".css")) return { code: dropWoffFallback(code), map: null };
      return undefined;
    },
  };
  const inline: Plugin = {
    name: "edid-studio-offline",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const files = Object.values(bundle);
      const chunks = files.filter((f): f is OutputChunk => f.type === "chunk");
      const html = files.find((f): f is OutputAsset => f.type === "asset" && f.fileName === "index.html");
      const css = files.filter((f): f is OutputAsset => f.type === "asset" && f.fileName.endsWith(".css"));
      const others = files.filter((f) => f.type === "asset" && f !== html && !css.includes(f as OutputAsset));
      if (chunks.length !== 1 || html === undefined || css.length > 1) {
        throw new Error(`offline build: expected one chunk, one page and at most one stylesheet, got ${files.map((f) => f.fileName).join(", ")}`);
      }
      if (others.length > 0) throw new Error(`offline build: assets were not inlined: ${others.map((f) => f.fileName).join(", ")}`);
      const [chunk] = chunks as [OutputChunk];

      const script = guardRawText(chunk.code, "script");
      const style = guardRawText(css[0] === undefined ? "" : String(css[0].source), "style");
      let page = String(html.source);
      const scriptTag = /<script type="module" crossorigin src="[^"]*"><\/script>/;
      const styleTag = /<link rel="stylesheet" crossorigin href="[^"]*">/;
      if (!scriptTag.test(page)) throw new Error("offline build: script tag not found");
      // Replacer functions, so "$" in the code is not read as a pattern.
      page = page.replace(scriptTag, () => "");
      page = css[0] === undefined ? page : page.replace(styleTag, () => `<style>${style}</style>`);
      page = page.replace("</body>", () => `  <script type="module">${script}</script>\n  </body>`);
      page = page.replace(/<link rel="(icon|apple-touch-icon)" href="\.\/([^"]+\.png)"[^>]*>/g, (_m, rel: string, name: string) =>
        `<link rel="${rel}" href="${dataUri(new URL(name, publicDir), "image/png")}" type="image/png" />`,
      );
      const meta = `<meta http-equiv="Content-Security-Policy" content="${offlineCsp(sha256(script), sha256(style))}" />`;
      page = page.replace('<meta charset="utf-8" />', () => `<meta charset="utf-8" />\n    ${meta}`);

      // Rollup removes an output by deleting it from the bundle.
      for (const f of files) Reflect.deleteProperty(bundle, f.fileName);
      this.emitFile({ type: "asset", fileName: OFFLINE_FILE, source: page });
    },
  };
  return [fonts, inline];
}
