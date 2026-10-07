import { expect, test, type Page } from "@playwright/test";

const runName = "Open concert: Pagination investigation";

/** Run-detail controls share names with queue rows, so stay inside one detail surface. */
function detailButton(detail: ReturnType<Page["getByTestId"]>, name: string) {
  return detail.getByRole("button", { name, exact: true }).first();
}

test("Runs monitors source-agent progress and results without manual authoring", async ({
  page,
}) => {
  const detail = page.getByTestId("run-detail");
  const instance = (name: string) => detailButton(detail, name);
  await page.goto("/?runs");
  await expect(
    page.getByRole("button", { name: "New concert", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "Concerts", exact: true }).click();
  await page.getByRole("button", { name: runName, exact: true }).click();
  await expect(detail).toContainText("0 of 3 tasks reported complete");
  await expect(detail.getByRole("textbox")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Accept saved breakdown" }),
  ).toHaveCount(0);
  await expect(page.getByText(/Execution unavailable/)).toHaveCount(0);
  await page
    .getByRole("button", { name: "Source claims task", exact: true })
    .click();
  await expect(page.getByTestId("run-task-api")).toContainText("Running");
  await page
    .getByRole("button", { name: "Source reports blocker", exact: true })
    .click();
  await expect(page.getByTestId("run-task-api")).toContainText(
    "Confirm the pagination compatibility requirement",
  );
  await page
    .getByRole("button", { name: "Conductor agent", exact: true })
    .click();
  await expect(page.getByTestId("preview-status")).toContainText("agent-1");
  await page
    .getByRole("button", { name: "Source completes run", exact: true })
    .click();
  const apiCard = () => page.getByTestId("run-task-api");
  await expect(detail).toContainText("3 of 3 tasks reported complete");
  await expect(detail).toContainText("Compared both implementations");
  // The card metadata line merges the textual state with the muted task ID.
  await expect(apiCard()).toContainText("Completed");
  await expect(apiCard()).toContainText("· api");
  // Evidence opens in the footer's inset panel.
  await apiCard()
    .getByRole("button", { name: "Evidence 1", exact: true })
    .click();
  await expect(apiCard()).toContainText(
    "Reviewed the implementation and recorded the findings",
  );
  // Opening Checks closes the Evidence panel, one inset panel at a time.
  await apiCard()
    .getByRole("button", { name: "Checks 1/1 passed", exact: true })
    .click();
  await expect(apiCard()).toContainText("✓ Passed");
  await expect(apiCard()).toContainText("focused checks");
  await expect(apiCard()).toContainText("All checks passed");
  await expect(
    apiCard().getByRole("button", { name: "Evidence 1", exact: true }),
  ).not.toHaveAttribute("aria-expanded", "true");
  await expect(apiCard()).not.toContainText(
    "Reviewed the implementation and recorded the findings",
  );
  await instance("History").click();
  // Compact History: one row per attempt with index, task ID, state, and a
  // quiet Open agent action; the report summary is not repeated.
  const firstAttempt = detail.getByTestId("history-attempt-1");
  await expect(firstAttempt).toContainText("#1");
  await expect(firstAttempt).toContainText("api");
  await expect(firstAttempt).toContainText("Completed");
  await expect(
    firstAttempt.getByRole("button", {
      name: "Open agent · attempt 1",
      exact: true,
    }),
  ).toBeVisible();
  await expect(firstAttempt).not.toContainText("Compared both implementations");
  await page.getByRole("button", { name: "Complete", exact: true }).click();
  await expect(
    page.getByRole("button", { name: runName, exact: true }),
  ).toBeVisible();
});

test("Agents and Runs retain separate searches, selections and native answer drafts", async ({
  page,
}) => {
  const detail = page.getByTestId("run-detail");
  const instance = (name: string) => detailButton(detail, name);
  await page.goto("/?runs");
  await page
    .getByRole("textbox", { name: "Search agents and requests" })
    .fill("pagination");
  await page
    .getByRole("button", { name: /Open Choose a pagination strategy/ })
    .click();
  await page
    .getByRole("textbox", { name: "Answer: Pagination" })
    .fill("Keep this native answer");
  const badge = page.getByRole("button", {
    name: "Needs attention",
    exact: true,
  });
  const count = await badge.textContent();
  const tab = page.getByRole("tab", { name: "Concerts", exact: true });
  await tab.focus();
  await page.keyboard.press("Enter");
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("button", { name: "Next item →", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Open Choose a pagination strategy/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Active", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search concerts" })
    .fill("investigation");
  await page.getByRole("button", { name: runName, exact: true }).click();
  await instance("Graph").click();
  await expect(page.getByTestId("run-graph")).toBeVisible();
  await expect(page.getByTestId("run-node-collect")).toHaveAttribute(
    "aria-label",
    /Waits for api, ui/,
  );
  await expect(
    page.getByTestId("run-edge-api-collect-dependency-0"),
  ).toBeVisible();
  const queue = await page.getByTestId("runs-queue").boundingBox();
  const detailBox = await page.getByTestId("run-detail").boundingBox();
  expect(detailBox?.width ?? 0).toBeGreaterThan(queue?.width ?? 0);
  await page.getByRole("tab", { name: "Agents", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Search agents and requests" }),
  ).toHaveValue("pagination");
  await expect(
    page.getByRole("textbox", { name: "Answer: Pagination" }),
  ).toHaveValue("Keep this native answer");
  await expect(badge).toHaveText(count ?? "");
  await tab.click();
  await expect(
    page.getByRole("textbox", { name: "Search concerts" }),
  ).toHaveValue("investigation");
  await expect(page.getByTestId("run-graph")).toBeVisible();
  await expect(page.getByTestId("run-node-collect")).toHaveAttribute(
    "aria-label",
    /Waits for api, ui/,
  );
  await expect(
    page.getByTestId("run-edge-api-collect-dependency-0"),
  ).toBeVisible();
});

test("legacy plans are excluded from Runs and its counts", async ({ page }) => {
  await page.goto("/?runs&legacy-run");
  await page.getByRole("tab", { name: "Concerts", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Legacy plans", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: runName, exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("No concerts yet", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("agent-coverage")).toContainText("0 concerts");
  await expect(
    page.getByRole("button", { name: "All", exact: true }),
  ).toContainText("0");
});

test("Runs matches Agents control and row sizing with keyboard selection", async ({
  page,
}) => {
  await page.goto("/?runs");
  const agentSearch = await page
    .getByRole("textbox", { name: "Search agents and requests" })
    .boundingBox();
  const agentFilter = page.getByRole("button", {
    name: "Needs attention",
    exact: true,
  });
  const agentFilterStyle = await agentFilter.evaluate((element) => ({
    borderBottom: getComputedStyle(element).borderBottomWidth,
    height: element.getBoundingClientRect().height,
  }));
  const agentRow = page.getByRole("button", {
    name: /Open Choose a pagination strategy/,
  });
  const rowStyle = await agentRow.evaluate((element) => ({
    padding: getComputedStyle(element).padding,
    borderLeft: getComputedStyle(element).borderLeftWidth,
  }));
  await page.getByRole("tab", { name: "Concerts", exact: true }).click();
  const runSearch = await page
    .getByRole("textbox", { name: "Search concerts" })
    .boundingBox();
  expect(runSearch?.height).toBe(agentSearch?.height);
  expect(runSearch?.y).toBe(agentSearch?.y);
  const runFilter = page.getByRole("button", { name: "All", exact: true });
  expect(
    await runFilter.evaluate((element) => ({
      borderBottom: getComputedStyle(element).borderBottomWidth,
      height: element.getBoundingClientRect().height,
    })),
  ).toEqual(agentFilterStyle);
  const runRow = page.getByRole("button", { name: runName, exact: true });
  expect(
    await runRow.evaluate((element) => ({
      padding: getComputedStyle(element).padding,
      borderLeft: getComputedStyle(element).borderLeftWidth,
    })),
  ).toEqual(rowStyle);
  await expect(runRow).toContainText("Pagination investigation");
  await expect(runRow).not.toContainText("Open concert:");
  await runRow.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("run-detail")).toBeVisible();
  await expect(page.getByTestId("agent-coverage")).toContainText("1 concert");
});

test("run-store failures stay in Runs and do not disable native answers", async ({
  page,
}) => {
  await page.goto("/?runs&run-failed");
  await page.getByRole("tab", { name: "Concerts", exact: true }).click();
  await expect(
    page.getByText(/Concert storage could not refresh/),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Agents", exact: true }).click();
  await expect(
    page.getByText(/Concert storage could not refresh/),
  ).not.toBeVisible();
  await page
    .getByRole("button", { name: /Open Choose a pagination strategy/ })
    .click();
  await page.getByRole("radio", { name: "Cursor pagination" }).click();
  await expect(
    page.getByRole("button", { name: "Send answer", exact: true }),
  ).toBeEnabled();
});

test("compact monitoring preserves navigation and the accessible refresh icon", async ({
  page,
}) => {
  const detail = page.getByTestId("run-detail");
  const instance = (name: string) => detailButton(detail, name);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?runs&global&dark&stale");
  const refresh = page.getByRole("button", { name: "Refresh", exact: true });
  await expect(refresh).toHaveText("");
  await expect(refresh.locator("svg")).toBeVisible();
  await refresh.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("tab", { name: "Concerts", exact: true }).click();
  await page.getByRole("button", { name: runName, exact: true }).click();
  await instance("Graph").click();
  await expect(page.getByTestId("run-graph")).toBeVisible();
  await expect(page.getByTestId("run-node-collect")).toHaveAttribute(
    "aria-label",
    /Waits for api, ui/,
  );
  await expect(
    page.getByTestId("run-edge-api-collect-dependency-0"),
  ).toBeVisible();
  await expect(
    page.getByTestId("run-edge-api-collect-dependency-0"),
  ).toBeVisible();
  await expect(page.getByTestId("run-node-api")).toContainText("Ready");
  await expect(page.getByTestId("run-node-collect")).toContainText("Waiting");
  // Graph nodes exceed a 390px viewport, so the canvas scrolls internally while
  // the page itself never gains horizontal overflow.
  const canvas = await page
    .getByTestId("run-node-api")
    .evaluate((element: HTMLElement) => {
      let node: HTMLElement | null = element.parentElement;
      while (node && node.scrollWidth <= node.clientWidth) {
        node = node.parentElement;
      }
      if (!node || node === document.documentElement) {
        return null;
      }
      node.scrollLeft = 120;
      return {
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
        scrollLeft: node.scrollLeft,
      };
    });
  expect(canvas).not.toBeNull();
  expect(canvas ? canvas.scrollWidth : 0).toBeGreaterThan(
    canvas ? canvas.clientWidth : Infinity,
  );
  expect(canvas ? canvas.scrollLeft : 0).toBeGreaterThan(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const compactWidth = await page
    .getByTestId("run-node-api")
    .evaluate((element) => element.getBoundingClientRect().width);
  expect(compactWidth).toBeLessThanOrEqual(224);
  await page
    .getByRole("button", { name: "← Back to concerts", exact: true })
    .click();
  await page.getByRole("tab", { name: "Agents", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Open Choose a pagination strategy/ }),
  ).toBeVisible();
});

test("task and graph agent links open the actual worker and retain the conductor link", async ({
  page,
}) => {
  const detail = page.getByTestId("run-detail");
  const instance = (name: string) => detailButton(detail, name);
  await page.goto("/?runs");
  await page.getByRole("tab", { name: "Concerts", exact: true }).click();
  await page.getByRole("button", { name: runName, exact: true }).click();
  await expect(
    page.getByText("CONDUCTOR WORKSPACE", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Source claims task", exact: true })
    .click();
  await instance("Open api agent").click();
  await expect(page.getByTestId("preview-status")).toContainText("worker-api");
  await page
    .getByRole("button", { name: "Conductor agent", exact: true })
    .click();
  await expect(page.getByTestId("preview-status")).toContainText("agent-1");
  await instance("Graph").click();
  const api = page.getByTestId("run-node-api");
  await api.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("preview-status")).toContainText("worker-api");
  await expect(page.getByTestId("run-graph-selection")).toContainText(
    "Selected api",
  );
  const collect = page.getByTestId("run-node-collect");
  await collect.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("run-graph-selection")).toContainText(
    "Selected collect",
  );
  // Selection detail repeats the full title even though the node can truncate.
  await expect(page.getByTestId("run-graph-selection")).toContainText(
    "Investigate collect",
  );
  // A task without prerequisites says so in the selection detail.
  await api.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("run-graph-selection")).toContainText(
    "No dependencies",
  );
  const edge = page.getByTestId("run-edge-api-collect-dependency-0");
  await expect(edge).toBeVisible();
  const left = await api.boundingBox();
  const right = await collect.boundingBox();
  expect(right?.x ?? 0).toBeGreaterThan((left?.x ?? 0) + (left?.width ?? 0));
  await instance("History").click();
  await instance("Open agent · attempt 1").click();
  await expect(page.getByTestId("preview-status")).toContainText("worker-api");
});
