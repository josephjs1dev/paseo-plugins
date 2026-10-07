import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const endpoint = process.env.CONDUCTOR_TEST_URL;
if (!endpoint || !/^ws:\/\/127\.0\.0\.1:\d+\/ws$/.test(endpoint)) {
  throw new Error(
    "Set CONDUCTOR_TEST_URL to the disposable local test daemon WebSocket URL.",
  );
}
const address = new URL(endpoint);
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  // A test client may only open daemon sockets to the disposable host.
  await context.routeWebSocket(/.*/, async (socket) => {
    const target = new URL(socket.url());
    if (
      target.protocol === "ws:" &&
      ["127.0.0.1", "localhost"].includes(target.hostname) &&
      target.port === address.port &&
      target.pathname === "/ws"
    ) {
      socket.connectToServer();
    } else {
      await socket.close();
    }
  });
  const page = await context.newPage();
  await page.goto(`http://${address.host}/`);
  await page.getByRole("button", { name: "Conductor", exact: true }).click({
    timeout: 30000,
  });
  const podium = page.getByTestId("conductor-podium");
  await podium.getByRole("heading", { name: "Podium", exact: true }).waitFor();
  await podium.getByText("No agents in this scope", { exact: true }).waitFor();
  assert.equal(
    await podium
      .getByRole("button", { name: "Refresh", exact: true })
      .isEnabled(),
    true,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  // Paseo switches navigation shells at this breakpoint; reopen from its menu.
  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await page.getByRole("button", { name: "Conductor", exact: true }).click();
  await podium.getByRole("heading", { name: "Podium", exact: true }).waitFor();
  const bounds = await podium.boundingBox();
  assert.ok(bounds && bounds.width <= 390);
  console.log(
    "Host client passed: sidebar opens the real Podium, RPC renders, desktop and compact views load.",
  );
} finally {
  await browser.close();
}
