import { pathToFileURL } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// Local runs can point at installed browsers with PW_CHROMIUM_PATH and
// PW_FIREFOX_PATH; CI installs the browsers Playwright expects.
const chromiumPath = process.env["PW_CHROMIUM_PATH"];
const firefoxPath = process.env["PW_FIREFOX_PATH"];

/** The offline build, opened from disk as it is on a workstation (offline.ts). */
export const offlinePage = pathToFileURL(new URL("dist-offline/edid-studio.html", import.meta.url).pathname).href;

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  projects: [
    {
      name: "hosted",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: "http://localhost:4173",
        ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
      },
    },
    {
      name: "offline-firefox",
      use: {
        ...devices["Desktop Firefox"],
        baseURL: offlinePage,
        ...(firefoxPath ? { launchOptions: { executablePath: firefoxPath } } : {}),
      },
    },
  ],
  webServer: {
    command: "pnpm build && pnpm build:offline && pnpm preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env["CI"],
  },
});
