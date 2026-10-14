import { describe, expect, it } from "vitest";
import { describeDtd, lookupVic, modeLabel, parseDescriptor } from "../src/index.ts";
import type { DetailedTimingDescriptor } from "../src/index.ts";

describe("VIC table", () => {
  it("has VICs 1-127 and 193-219", () => {
    expect(lookupVic(1)).toBeDefined();
    expect(lookupVic(127)).toBeDefined();
    expect(lookupVic(128)).toBeUndefined();
    expect(lookupVic(193)).toBeDefined();
    expect(lookupVic(219)).toBeDefined();
    expect(lookupVic(220)).toBeUndefined();
  });

  it("VIC 96 is 4K50 at 594 MHz with the 1056-pixel front porch", () => {
    const v = lookupVic(96);
    expect(v).toMatchObject({ hActive: 3840, vActive: 2160, pixelClockKHz: 594000, hTotal: 5280 });
    expect(v?.refreshHz).toBeCloseTo(50, 9);
  });

  it.each([
    [16, "1920x1080 @ 60.000 Hz"],
    [97, "3840x2160 @ 60.000 Hz"],
    [5, "1920x1080i @ 60.000 Hz"],
    [39, "1920x1080i @ 50.000 Hz"],
    [2, "720x480 @ 59.940 Hz"],
  ])("VIC %i is %s", (vic, label) => {
    const v = lookupVic(vic);
    expect(v && modeLabel(v)).toBe(label);
  });
});

describe("DTD description", () => {
  it("the case-study timing is exactly 50 Hz on a 4000 x 2220 total", () => {
    const d = parseDescriptor([0x70, 0xad, 0x00, 0xa0, 0xf0, 0x70, 0x3c, 0x80, 0x30, 0x20, 0x8a, 0, 0, 0, 0, 0, 0, 0x1a]) as DetailedTimingDescriptor;
    const info = describeDtd(d);
    expect(info).toMatchObject({ hTotal: 4000, vTotal: 2220, pixelClockKHz: 444000, hBackPorch: 80, vBackPorch: 42, hSyncPositive: true, vSyncPositive: false });
    expect(info.refreshHz).toBe(50);
    expect(modeLabel(info)).toBe("3840x2160 @ 50.000 Hz");
  });
});
