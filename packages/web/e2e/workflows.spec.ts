import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { importEdid, manufacturerId } from "@edid-studio/core";

const fixture = (name: string) => readFileSync(new URL(`../../../tests/fixtures/${name}`, import.meta.url), "utf8");

async function download(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Export…" }).click();
  const [file] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /^Download/ }).click()]);
  return readFileSync(await file.path(), "utf8");
}

async function fill(page: Page, values: Record<string, string>) {
  for (const [label, value] of Object.entries(values)) await page.getByLabel(label, { exact: true }).fill(value);
}

test("reproduces the Tessera fix in the UI, byte for byte", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Paste hex").fill(fixture("Tessera-EJE-test.txt"));
  await page.getByRole("button", { name: "Load pasted hex" }).click();
  // The editor explains why the original falls back from 10-bit.
  await expect(page.locator("ul.issues li.warning", { hasText: "10-bit RGB needs 742.50 MHz" }).first()).toBeVisible();
  await expect(page.locator("ul.issues li.warning code.rule", { hasText: "link.too-fast" }).first()).toBeVisible();

  // 1. Custom 4K50 timing with the case-study porches; strip every other mode.
  await page.getByRole("button", { name: "Custom resolution…" }).click();
  await page.getByLabel("Formula").selectOption("manual");
  await fill(page, { "H front porch": "48", "H sync": "32", "H back porch": "80", "V front porch": "8", "V sync": "10", "V back porch": "42" });
  await expect(page.locator(".tresult")).toContainText("444.00 MHz");
  await expect(page.locator(".tresult")).toContainText("exact");
  await page.getByLabel("fit range limits to the modes").uncheck();
  await page.getByRole("button", { name: "Set as preferred timing" }).click();

  // 2. RGB only, 8 and 10-bit.
  await page.getByRole("button", { name: /^CTA header/ }).click();
  await page.getByLabel("YCbCr 4:4:4").uncheck();
  await page.getByLabel("YCbCr 4:2:2").uncheck();
  await page.getByLabel("12-bit").uncheck();
  await page.getByRole("button", { name: "Apply colour and depth" }).click();

  // 3. Range limits as in the recipe.
  await page.getByRole("button", { name: "Range limits" }).click();
  await fill(page, { "Min vertical (Hz)": "50", "Max vertical (Hz)": "50", "Min horizontal (kHz)": "110", "Max horizontal (kHz)": "113", "Max pixel clock (MHz)": "600" });
  await page.getByLabel("Timing formula").selectOption("none");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator(".issues li.error")).toHaveCount(0);

  const out = importEdid(await download(page));
  const fixed = importEdid(fixture("Tessera-EJE-4K50-10bit-RGB.txt"));
  expect(Buffer.from(out.bytes).toString("hex")).toBe(Buffer.from(fixed.bytes).toString("hex"));
});

test("creates an EDID without uploading anything", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create a new EDID" }).click();
  await fill(page, { Width: "3840", Height: "1080", "Refresh (Hz)": "50" });
  await page.getByLabel("Monitor name (up to 13 characters)").fill("Wall A");
  await expect(page.locator(".tresult")).toContainText("exact");
  await page.getByRole("button", { name: "Create EDID" }).click();
  await expect(page.locator(".kf .n").first()).toHaveText("3840x1080 @ 50.000 Hz");

  const text = await download(page);
  expect(text.trim().split("\n")).toHaveLength(1);
  const { edid, checksumErrors } = importEdid(text);
  expect(checksumErrors).toEqual([]);
  expect([edid.base.version, edid.base.revision]).toEqual([1, 3]);
  expect(manufacturerId(edid.base.manufacturerCode)).toBe("VYV");
  // One mode only: no established timings unless 640x480 is asked for.
  expect(edid.base.establishedTimings).toEqual([0, 0, 0]);
  const cta = edid.extensions[0];
  expect(cta?.kind === "cta" && cta.dataBlocks.find((b) => b.kind === "hdmiVsdb")).toMatchObject({ capabilities: { dc30bit: true, dc36bit: false } });
});

test("refuses a resolution a DTD cannot hold, by field name", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create a new EDID" }).click();
  await page.getByLabel("Formula").selectOption("manual");
  await fill(page, { "H front porch": "1056", "H sync": "88", "H back porch": "296", "V front porch": "8", "V sync": "10", "V back porch": "72" });
  await expect(page.locator(".timing .issues")).toContainText("horizontal front porch 1056 exceeds 1023");
  await expect(page.locator(".tresult")).toContainText("Not a DTD");
});

test("edits base-block standard timings", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Paste hex").fill(fixture("Tessera-EJE-test.txt"));
  await page.getByRole("button", { name: "Load pasted hex" }).click();
  await page.getByRole("button", { name: "Standard timings" }).click();
  await expect(page.locator(".std-row").first()).toContainText("720x576 @ 60 Hz (5:4)");
  await page.locator(".std-row").first().getByRole("button", { name: "Remove" }).click();
  await expect(page.locator(".std-row").first()).toContainText("unused");
  await fill(page, { "Width (256-2288, steps of 8)": "1920", "Refresh (60-123 Hz)": "60" });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.locator(".std-row").first()).toContainText("1920x1080 @ 60 Hz (16:9)");
});
