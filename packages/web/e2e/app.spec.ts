import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { importEdid } from "@edid-studio/core";

/** Fails the test on console errors, CSP violations or any off-site request. */
function guard(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.protocol !== "data:" && url.protocol !== "blob:" && url.host !== "localhost:4173") problems.push(`request: ${r.url()}`);
  });
  return problems;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("shows the VYV logo and the headline", async ({ page }) => {
  const logo = page.getByRole("img", { name: "VYV" });
  await expect(logo).toBeVisible();
  expect(await logo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(271);
  await expect(page.getByRole("heading", { name: "Make the GPU pick the mode you want" })).toBeVisible();
});

test("serves a Content Security Policy that blocks network access", async ({ page }) => {
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain("script-src 'self'");
});

test("strip down a sample and download it", async ({ page }) => {
  const problems = guard(page);
  await page.getByRole("button", { name: "Try a sample" }).click();
  await expect(page.locator(".kf .n").first()).toHaveText("3840x2160 @ 60.000 Hz");

  await page.getByRole("button", { name: /^Video modes/ }).click();
  await page.getByRole("button", { name: "Remove VIC 97" }).click();
  await page.getByRole("button", { name: "HDMI 1.4 VSDB" }).click();
  await page.getByLabel("10-bit").check();
  await expect(page.locator(".history li")).toHaveCount(3);

  await page.getByRole("button", { name: "Export…" }).click();
  await expect(page.getByText("all checksums correct")).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /^Download/ }).click()]);
  expect(download.suggestedFilename()).toBe("DELL-P2415Q.txt");

  // The downloaded file must re-import with the edits in place.
  const path = await download.path();
  const { edid, checksumErrors } = importEdid(readFileSync(path, "utf8"));
  expect(checksumErrors).toEqual([]);
  const cta = edid.extensions[0];
  if (cta?.kind !== "cta") throw new Error("CTA block missing");
  const vics = cta.dataBlocks.flatMap((b) => (b.kind === "video" ? b.svds.map((s) => s.vic) : []));
  expect(vics).not.toContain(97);
  expect(cta.dataBlocks.find((b) => b.kind === "hdmiVsdb")).toMatchObject({ capabilities: { dc30bit: true } });
  expect(problems).toEqual([]);
});

test("undo restores the previous state", async ({ page }) => {
  await page.getByRole("button", { name: "Try a sample" }).click();
  await page.getByRole("button", { name: /^Video modes \(24\)/ }).click();
  await page.getByRole("button", { name: "Remove VIC 16" }).click();
  await expect(page.getByRole("button", { name: /^Video modes \(23\)/ })).toBeVisible();
  await page.keyboard.press("Control+z");
  await expect(page.getByRole("button", { name: /^Video modes \(24\)/ })).toBeVisible();
});

test("refuses a non-EDID upload by content and by name", async ({ page }) => {
  const problems = guard(page);
  const input = page.locator('input[type="file"]');
  await input.setInputFiles({ name: "photo.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(200).fill(0)]) });
  await expect(page.getByRole("alert")).toContainText("looks like a PNG image");
  await input.setInputFiles({ name: "edid.exe", mimeType: "application/octet-stream", buffer: Buffer.from("00 ff") });
  await expect(page.getByRole("alert")).toContainText(".exe files are not accepted");
  expect(problems).toEqual([]);
});

test("pasted markup is shown as text, never run", async ({ page }) => {
  const problems = guard(page);
  await page.getByLabel("Paste hex").fill('00 ff <img src=x onerror="document.title=\'pwned\'">');
  await page.getByRole("button", { name: "Load pasted hex" }).click();
  await expect(page.getByRole("alert")).toContainText('"<img" is not a hex byte');
  await expect(page.locator("main img")).toHaveCount(0);
  expect(await page.title()).toBe("EDID Studio");
  expect(problems).toEqual([]);
});

test("a monitor name with markup renders literally", async ({ page }) => {
  await page.getByRole("button", { name: "Try a sample" }).click();
  await page.getByRole("button", { name: /^Monitor name/ }).click();
  await page.getByRole("textbox", { name: /Monitor name/ }).fill("<img src=x>");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.locator(".kf .n").nth(1)).toHaveText("<img src=x>");
  await expect(page.locator("main img")).toHaveCount(0);
});

test("structure tree works from the keyboard", async ({ page }) => {
  await page.getByRole("button", { name: "Try a sample" }).click();
  const current = page.locator('.tree button[aria-current="true"]');
  await current.focus();
  const before = await current.textContent();
  await page.keyboard.press("ArrowDown");
  await expect(current).not.toHaveText(before ?? "");
  await expect(current).toBeFocused();
});
