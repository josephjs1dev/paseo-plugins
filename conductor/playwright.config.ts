import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  // Files are serialized inside themselves already; running two or more files
  // concurrently put the heaviest Graph-click probes (fixtures, layout probe)
  // under CPU contention on the shared dev server and made their 30s test
  // timeouts flaky. One worker keeps each run deterministic; the whole suite
  // stays under three minutes.
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5178",
    headless: true,
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run preview",
    url: "http://127.0.0.1:5178",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
