// A real HDMI 2.0 4K60 monitor EDID from the edid-decode corpus (MIT),
// embedded at build time (vite.config.ts) so trying it makes no request.
import sampleBase64 from "virtual:sample-edid";

export const SAMPLE_NAME = "dell-p2415q-hdmi2.0.bin";

export function sampleBytes(): Uint8Array {
  return Uint8Array.from(atob(sampleBase64), (c) => c.charCodeAt(0));
}
