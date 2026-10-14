import { defineConfig } from "@playwright/test";

// Local runs can point at an installed Chromium with PW_CHROMIUM_PATH; CI
// installs the browser Playwright expects.
const executablePath = process.env["PW_CHROMIUM_PATH"];

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:4173",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: {
    command: "pnpm build && pnpm preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env["CI"],
  },
});
