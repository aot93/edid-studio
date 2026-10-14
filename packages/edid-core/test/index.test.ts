import { describe, expect, it } from "vitest";
import { expectedEdidLength } from "../src/index.ts";

describe("expectedEdidLength", () => {
  it("is 128 x (1 + extension count)", () => {
    expect(expectedEdidLength(0)).toBe(128);
    expect(expectedEdidLength(1)).toBe(256);
  });
});
