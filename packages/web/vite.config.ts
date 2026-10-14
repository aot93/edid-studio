import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

/**
 * Content Security Policy for the built site (SPEC.md section 13). Added at
 * build time only: the dev server needs inline scripts for hot reload.
 * Headers a meta tag cannot carry (frame-ancestors and others) are in
 * public/_headers for hosts that read it.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function contentSecurityPolicy(): Plugin {
  return {
    name: "edid-studio-csp",
    apply: "build",
    transformIndexHtml: (html) =>
      html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  };
}

/**
 * `virtual:sample-edid`: a real EDID from the test corpus, embedded as
 * base64 at build time so "Try a sample" needs no network request.
 */
function sampleEdid(): Plugin {
  const id = "virtual:sample-edid";
  const file = new URL("../../tests/corpus/edid-decode/dell-p2415q-hdmi2.0", import.meta.url);
  return {
    name: "edid-studio-sample",
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    load(resolved) {
      if (resolved !== `\0${id}`) return undefined;
      this.addWatchFile(file.pathname);
      return `export default ${JSON.stringify(readFileSync(file).toString("base64"))};`;
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), sampleEdid(), contentSecurityPolicy()],
  build: { assetsInlineLimit: 0, sourcemap: false },
});
