import { expect, test, type Page } from "@playwright/test";

const symphonyName = "Open symphony: Pagination investigation";

/** Symphony-detail controls share names with queue rows, so stay inside one detail surface. */
function detailButton(detail: ReturnType<Page["getByTestId"]>, name: string) {
  return detail.getByRole("button", { name, exact: true }).first();
}

test("Symphonies monitors start/claim progress and results without manual authoring", async ({
  page,
}) => {
  const detail = page.getByTestId("symphony-detail");
  const instance = (name: string) => detailButton(detail, name);
  await page.goto("/?symphonies");
  await expect(
    page.getByRole("button", { name: "New symphony", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "Symphonies", exact: true }).click();
  await page.getByRole("button", { name: symphonyName, exact: true }).click();
  await expect(detail).toContainText("0 of 3 tasks reported complete");
  await expect(detail.getByRole("textbox")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Accept saved breakdown" }),
  ).toHaveCount(0);
  await expect(page.getByText(/Execution unavailable/)).toHaveCount(0);
  await page
    .getByRole("button", { name: "Source claims task", exact: true })
    .click();
  await expect(page.getByTestId("symphony-task-api")).toContainText("Running");
  await page
    .getByRole("button", { name: "Source reports blocker", exact: true })
    .click();
  await expect(page.getByTestId("symphony-task-api")).toContainText(
    "Confirm the pagination compatibility requirement",
  );
  await page
    .getByRole("button", { name: "Conductor agent", exact: true })
    .click();
  await expect(page.getByTestId("preview-status")).toContainText("agent-1");
  await page
    .getByRole("button", { name: "Source completes symphony", exact: true })
    .click();
  const apiCard = () => page.getByTestId("symphony-task-api");
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
  // Compact History: one section per task, and a task with one attempt is a
  // single row without an attempt number; the report summary is not repeated.
  const firstAttempt = detail.getByTestId("history-task-api");
  await expect(firstAttempt).toContainText("api");
  await expect(firstAttempt).toContainText("Completed");
  await expect(firstAttempt).not.toContainText("Attempt 1");
  await expect(
    firstAttempt.getByRole("button", {
      name: "Open agent · api",
      exact: true,
    }),
  ).toBeVisible();
  await expect(firstAttempt).not.toContainText("Compared both implementations");
  await page.getByRole("button", { name: "Complete", exact: true }).click();
  await expect(
    page.getByRole("button", { name: symphonyName, exact: true }),
  ).toBeVisible();
});

test("Agents and Symphonies retain separate searches, selections and native answer drafts", async ({
  page,
}) => {
  const detail = page.getByTestId("symphony-detail");
  const instance = (name: string) => detailButton(detail, name);
  await page.goto("/?symphonies");
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
  const tab = page.getByRole("tab", { name: "Symphonies", exact: true });
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
    .getByRole("textbox", { name: "Search symphonies" })
    .fill("investigation");
  await page.getByRole("button", { name: symphonyName, exact: true }).click();
  await instance("Graph").click();
  await expect(page.getByTestId("symphony-graph")).toBeVisible();
  await expect(page.getByTestId("symphony-node-collect")).toHaveAttribute(
    "aria-label",
    /Waits for api, ui/,
  );
  await expect(
    page.getByTestId("symphony-edge-api-collect-dependency-0"),
  ).toBeVisible();
  const queue = await page.getByTestId("symphonies-queue").boundingBox();
  const detailBox = await page.getByTestId("symphony-detail").boundingBox();
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
    page.getByRole("textbox", { name: "Search symphonies" }),
  ).toHaveValue("investigation");
  await expect(page.getByTestId("symphony-graph")).toBeVisible();
  await expect(page.getByTestId("symphony-node-collect")).toHaveAttribute(
    "aria-label",
    /Waits for api, ui/,
  );
  await expect(
    page.getByTestId("symphony-edge-api-collect-dependency-0"),
  ).toBeVisible();
});

test("Symphonies matches Agents control and row sizing with keyboard selection", async ({
  page,
}) => {
  await page.goto("/?symphonies");
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
  await page.getByRole("tab", { name: "Symphonies", exact: true }).click();
  const symphonySearch = await page
    .getByRole("textbox", { name: "Search symphonies" })
    .boundingBox();
  expect(symphonySearch?.height).toBe(agentSearch?.height);
  expect(symphonySearch?.y).toBe(agentSearch?.y);
  const symphonyFilter = page.getByRole("button", { name: "All", exact: true });
  expect(
    await symphonyFilter.evaluate((element) => ({
      borderBottom: getComputedStyle(element).borderBottomWidth,
      height: element.getBoundingClientRect().height,
    })),
  ).toEqual(agentFilterStyle);
  const symphonyRow = page.getByRole("button", {
    name: symphonyName,
    exact: true,
  });
  expect(
    await symphonyRow.evaluate((element) => ({
      padding: getComputedStyle(element).padding,
      borderLeft: getComputedStyle(element).borderLeftWidth,
    })),
  ).toEqual(rowStyle);
  await expect(symphonyRow).toContainText("Pagination investigation");
  await expect(symphonyRow).not.toContainText("Open symphony:");
  await symphonyRow.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("symphony-detail")).toBeVisible();
  await expect(page.getByTestId("agent-coverage")).toContainText("1 symphony");
});

test("symphony-store failures stay in Symphonies and do not disable native answers", async ({
  page,
}) => {
  await page.goto("/?symphonies&symphony-failed");
  await page.getByRole("tab", { name: "Symphonies", exact: true }).click();
  await expect(
    page.getByText(/Symphony storage could not refresh/),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Agents", exact: true }).click();
  await expect(
    page.getByText(/Symphony storage could not refresh/),
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
  const detail = page.getByTestId("symphony-detail");
  const instance = (name: string) => detailButton(detail, name);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?symphonies&global&dark&stale");
  const refresh = page.getByRole("button", { name: "Refresh", exact: true });
  await expect(refresh).toHaveText("");
  await expect(refresh.locator("svg")).toBeVisible();
  await refresh.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("tab", { name: "Symphonies", exact: true }).click();
  await page.getByRole("button", { name: symphonyName, exact: true }).click();
  await instance("Graph").click();
  await expect(page.getByTestId("symphony-graph")).toBeVisible();
  await expect(page.getByTestId("symphony-node-collect")).toHaveAttribute(
    "aria-label",
    /Waits for api, ui/,
  );
  await expect(
    page.getByTestId("symphony-edge-api-collect-dependency-0"),
  ).toBeVisible();
  await expect(
    page.getByTestId("symphony-edge-api-collect-dependency-0"),
  ).toBeVisible();
  await expect(page.getByTestId("symphony-node-api")).toContainText("Ready");
  await expect(page.getByTestId("symphony-node-collect")).toContainText(
    "Waiting",
  );
  // Graph nodes exceed a 390px viewport, so the canvas scrolls internally while
  // the page itself never gains horizontal overflow.
  const canvas = await page
    .getByTestId("symphony-node-api")
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
    .getByTestId("symphony-node-api")
    .evaluate((element) => element.getBoundingClientRect().width);
  expect(compactWidth).toBeLessThanOrEqual(224);
  await page
    .getByRole("button", { name: "← Back to symphonies", exact: true })
    .click();
  await page.getByRole("tab", { name: "Agents", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Open Choose a pagination strategy/ }),
  ).toBeVisible();
});

test("task and graph agent links open the actual task agent and retain the Conductor link", async ({
  page,
}) => {
  const detail = page.getByTestId("symphony-detail");
  const instance = (name: string) => detailButton(detail, name);
  await page.goto("/?symphonies");
  await page.getByRole("tab", { name: "Symphonies", exact: true }).click();
  await page.getByRole("button", { name: symphonyName, exact: true }).click();
  await expect(
    page.getByText("CONDUCTOR CONCERT", { exact: true }),
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
  const api = page.getByTestId("symphony-node-api");
  await api.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("preview-status")).toContainText("worker-api");
  await expect(page.getByTestId("symphony-graph-selection")).toContainText(
    "Selected api",
  );
  const collect = page.getByTestId("symphony-node-collect");
  await collect.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("symphony-graph-selection")).toContainText(
    "Selected collect",
  );
  // Selection detail repeats the full title even though the node can truncate.
  await expect(page.getByTestId("symphony-graph-selection")).toContainText(
    "Investigate collect",
  );
  // A task without prerequisites says so in the selection detail.
  await api.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("symphony-graph-selection")).toContainText(
    "No dependencies",
  );
  const edge = page.getByTestId("symphony-edge-api-collect-dependency-0");
  await expect(edge).toBeVisible();
  const left = await api.boundingBox();
  const right = await collect.boundingBox();
  expect(right?.x ?? 0).toBeGreaterThan((left?.x ?? 0) + (left?.width ?? 0));
  await instance("History").click();
  await detail
    .getByTestId("history-task-api")
    .getByRole("button", { name: "Open agent · api", exact: true })
    .click();
  await expect(page.getByTestId("preview-status")).toContainText("worker-api");
});

test("Symphonies groups interleaved projects and omits same-name concert prefixes", async ({
  page,
}) => {
  await page.goto("/?symphonies&symphony-fixture=projects");
  await page.getByRole("tab", { name: "Symphonies", exact: true }).click();
  const queue = page.getByTestId("symphonies-queue");
  // One heading per project in first-seen list order: Northwind leads even
  // though Harbor's first row is second overall.
  const northwind = queue.getByText("NORTHWIND", { exact: true });
  const harbor = queue.getByText("HARBOR", { exact: true });
  await expect(northwind).toHaveCount(1);
  await expect(harbor).toHaveCount(1);
  const northwindY = await northwind.boundingBox();
  const harborY = await harbor.boundingBox();
  expect(northwindY?.y ?? Number.NaN).toBeLessThan(harborY?.y ?? Number.NaN);
  const exportApi = queue.getByTestId(
    "symphony-row-f1151538-5302-4fbf-b50b-f6a55f2a5b51",
  );
  const harborIntake = queue.getByTestId(
    "symphony-row-f1151538-5302-4fbf-b50b-f6a55f2a5b52",
  );
  const exportUi = queue.getByTestId(
    "symphony-row-f1151538-5302-4fbf-b50b-f6a55f2a5b53",
  );
  const storageResearch = queue.getByTestId(
    "symphony-row-f1151538-5302-4fbf-b50b-f6a55f2a5b54",
  );
  await expect(exportApi).toContainText("export-api ·");
  await expect(exportUi).toContainText("export-ui ·");
  // Northwind's rows keep their list order and stay inside their group.
  const exportApiY = await exportApi.boundingBox();
  const exportUiY = await exportUi.boundingBox();
  expect(exportApiY?.y ?? Number.NaN).toBeLessThan(exportUiY?.y ?? Number.NaN);
  expect(exportUiY?.y ?? Number.NaN).toBeLessThan(harborY?.y ?? Number.NaN);
  // A concert sharing its project's name drops the prefix; others keep it.
  await expect(harborIntake).toContainText("Harbor intake review");
  await expect(harborIntake).not.toContainText("Harbor ·");
  await expect(storageResearch).toContainText("storage-research ·");
  const harborIntakeY = await harborIntake.boundingBox();
  const storageResearchY = await storageResearch.boundingBox();
  expect(harborIntakeY?.y ?? Number.NaN).toBeLessThan(
    storageResearchY?.y ?? Number.NaN,
  );
  await storageResearch.click();
  await expect(page.getByTestId("symphony-detail")).toContainText(
    "Storage research",
  );
});

test("Symphonies groups rows by project and prints the goal once in Context", async ({
  page,
}) => {
  await page.goto("/?symphonies&symphony-fixture=goal-echo");
  await page.getByRole("tab", { name: "Symphonies", exact: true }).click();
  // The project heading matches the Agents queue label style; the row keeps
  // the concert name only when it differs from the project.
  await expect(
    page
      .getByTestId("symphonies-queue")
      .getByText("NORTHWIND", { exact: true }),
  ).toBeVisible();
  const row = page.getByRole("button", { name: symphonyName, exact: true });
  await expect(row).toContainText("Conductor concert");
  // Project names are searchable like titles and concerts.
  await page
    .getByRole("textbox", { name: "Search symphonies" })
    .fill("northwind");
  await expect(row).toBeVisible();
  await row.click();
  const detail = page.getByTestId("symphony-detail");
  await detailButton(detail, "Context").click();
  // Orchestrated symphonies carry the goal as both plan and outcome; the goal
  // must print once and the duplicated outcome line must disappear.
  const goal = "Investigate API and UI pagination, then collect the findings.";
  await expect(detail.getByText(goal, { exact: true })).toHaveCount(1);
  await expect(detail.getByText(/Expected outcome/)).toHaveCount(0);
});
