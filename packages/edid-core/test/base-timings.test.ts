import { describe, expect, it } from "vitest";
import { decodeStandardTiming, encodeStandardTiming, ESTABLISHED_TIMINGS, EdidEncodeError, isEstablishedSet } from "../src/index.ts";

describe("standard timings", () => {
  it("decodes the original Tessera code 3b 80 as 720x576 @ 60 Hz 5:4 (as edid-decode does)", () => {
    expect(decodeStandardTiming([0x3b, 0x80])).toEqual({ hActive: 720, vActive: 576, aspect: "5:4", refreshHz: 60 });
  });

  it("treats 01 01 as unused", () => {
    expect(decodeStandardTiming([0x01, 0x01])).toBeUndefined();
  });

  it.each([
    [1920, "16:9", 60],
    [1280, "16:10", 75],
    [1024, "4:3", 85],
    [2288, "16:9", 123],
  ] as const)("%i %s @ %i round-trips", (hActive, aspect, refreshHz) => {
    const code = encodeStandardTiming({ hActive, aspect, refreshHz });
    expect(decodeStandardTiming(code)).toMatchObject({ hActive, aspect, refreshHz });
  });

  it.each([
    [3840, "16:9", 60],
    [1921, "16:9", 60],
    [1920, "16:9", 50],
    [1920, "16:9", 124],
  ] as const)("refuses %i %s @ %i", (hActive, aspect, refreshHz) => {
    expect(() => encodeStandardTiming({ hActive, aspect, refreshHz })).toThrow(EdidEncodeError);
  });
});

describe("established timings", () => {
  it("has 17 timings and reads the Tessera bytes 21 08 00 as 640x480, 800x600 and 1024x768 at 60 Hz", () => {
    expect(ESTABLISHED_TIMINGS).toHaveLength(17);
    const set = ESTABLISHED_TIMINGS.filter((t) => isEstablishedSet([0x21, 0x08, 0x00], t)).map((t) => t.label);
    expect(set).toEqual(["640x480 @ 60 Hz", "800x600 @ 60 Hz", "1024x768 @ 60 Hz"]);
  });
});
