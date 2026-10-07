import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { longSummary, longTaskTitle } from "../run-fixtures";

/**
 * Integration verification for the Tasks and Graph UI.
 *
 * Every fixture scenario in tests/preview/runs.ts is exercised end-to-end
 * through the real preview surface, and representative Tasks/Graph screenshots
 * are written under .artifacts/reviews/20261006-conductor-run-ui/screenshots/
 * for visual inspection. Only fixtures and tests live here; production client
 * code is not touched by this spec.
 */

const SHOTS = fileURLToPath(
  new URL(
    "../../../.artifacts/reviews/20261006-conductor-run-ui/screenshots",
    import.meta.url,
  ),
);

async function openRun(page: Page, fixture: string, extra = "") {
  await page.goto(`/?runs&run-fixture=${fixture}${extra}`);
  await page.getByRole("tab", { name: "Concerts", exact: true }).click();
  await page
    .getByRole("button", { name: /^Open concert:/ })
    .first()
    .click();
  await expect(page.getByTestId("run-detail")).toBeVisible();
}

/** Run-detail controls share names with queue rows, so stay inside one detail surface. */
function detailButton(detail: Locator, name: string) {
  return detail.getByRole("button", { name, exact: true }).first();
}

async function noPageOverflow(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= innerWidth,
  );
}

test("fixture scenarios render their documented task and graph states", async ({
  page,
}) => {
  const detail = page.getByTestId("run-detail");

  // One-task long-title case: the full title stays visible on the card and in
  // the graph selection label even though the node body truncates it.
  await openRun(page, "long-title");
  await expect(page.getByTestId("run-task-migration")).toContainText(
    longTaskTitle,
  );
  await expect(page.getByTestId("run-task-migration")).toContainText("Running");
  await detailButton(detail, "Graph").click();
  const migration = page.getByTestId("run-node-migration");
  await expect(migration).toContainText("Running");
  await expect(migration).toHaveAttribute(
    "aria-label",
    new RegExp(longTaskTitle),
  );
  await migration.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("run-graph-selection")).toContainText(
    longTaskTitle,
  );

  // Multi-task graph: running, waiting, blocked, completed + failed check,
  // finishing, ready, and a same-layer resource conflict edge.
  await openRun(page, "multi");
  await expect(page.getByTestId("run-task-api")).toContainText("Running");
  await expect(page.getByTestId("run-task-ui")).toContainText(
    "Waiting · waiting for api",
  );
  await expect(page.getByTestId("run-task-backend")).toContainText("Blocked");
  await expect(page.getByTestId("run-task-backend")).toContainText(
    "Confirm the pagination compatibility requirement",
  );
  await expect(page.getByTestId("run-task-collect")).toContainText("Completed");
  await expect(page.getByTestId("run-task-collect")).toContainText(
    "✕ Regression suite: Offset export test still red.",
  );
  await expect(page.getByTestId("run-task-ship")).toContainText("Finishing");
  const collect = page.getByTestId("run-task-collect");
  await detailButton(collect, "Evidence 2").click();
  await expect(collect).toContainText(
    "Reviewed the API cursor implementation and the UI fixtures.",
  );
  await detailButton(collect, "Checks 2/3 passed · 1 failed").click();
  await expect(collect).toContainText("✓ Passed");
  await expect(collect).toContainText("API cursor coverage");
  await detailButton(detail, "Graph").click();
  const graph = page.getByTestId("run-graph");
  await expect(graph).toBeVisible();
  await expect(page.getByTestId("run-node-api")).toContainText("Running");
  await expect(page.getByTestId("run-node-ui")).toHaveAttribute(
    "aria-label",
    /Waits for api/,
  );
  await expect(page.getByTestId("run-node-collect")).toContainText("Completed");
  await expect(page.getByTestId("run-node-ship")).toContainText("Finishing");
  await expect(page.getByTestId("run-edge-api-ui-dependency-0")).toBeVisible();
  await expect(
    page.getByTestId(/run-edge-.*-conflict-0/).first(),
  ).toBeVisible();

  // Blocked run with an actionable message.
  await openRun(page, "blocked");
  await expect(page.getByTestId("run-task-export")).toContainText("Blocked");
  await expect(detail).toContainText(
    "Confirm the pagination compatibility requirement in the source conversation.",
  );

  // Failed checks survive default collapsed disclosure and Show more keeps the
  // full five-line summary reachable instead of discarding text.
  await openRun(page, "failed-checks");
  await expect(page.getByTestId("run-task-review")).toContainText(
    "✕ Regression suite: Offset export test still red.",
  );
  await expect(detail).toContainText(
    "RESULT · REPORTED BY THE CONDUCTOR AGENT",
  );
  await expect(
    page.getByRole("button", { name: "Show more", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show more", exact: true }).click();
  await expect(detail).toContainText(
    "The full evidence trail is recorded in the run history.",
  );

  // Waiting: api is completed so collect still waits on the unfinished ui.
  await openRun(page, "waiting");
  await expect(page.getByTestId("run-task-api")).toContainText("Completed");
  await expect(page.getByTestId("run-task-ui")).toContainText("Ready");
  await expect(page.getByTestId("run-task-collect")).toContainText(
    "Waiting · waiting for ui",
  );

  // Finishing: a reported completion with an unsettled agent launch. History
  // holds one compact row per attempt plus a per-revision task disclosure, and
  // it never repeats the report summary that lives on the task card.
  await openRun(page, "finishing");
  await expect(page.getByTestId("run-task-deliver")).toContainText("Finishing");
  await detailButton(detail, "History").click();
  await expect(detail).toContainText("ATTEMPTS");
  await expect(detail).toContainText("REVISIONS");
  const attemptRow = page.getByTestId("history-attempt-1");
  await expect(attemptRow).toContainText("#1");
  await expect(attemptRow).toContainText("deliver");
  await expect(attemptRow).toContainText("Finishing");
  await expect(attemptRow).toContainText("5m");
  await expect(attemptRow).not.toContainText(
    "Delivery package handed to the source.",
  );
  await attemptRow
    .getByRole("button", { name: "Open agent · attempt 1" })
    .click();
  await expect(page.getByTestId("preview-status")).toContainText(
    "worker-deliver",
  );
  const revisionRow = page.getByTestId("history-revision-1");
  await expect(revisionRow).toContainText("R1");
  await expect(revisionRow).toContainText("· 1 task");
  await expect(revisionRow).not.toContainText("Investigate deliver");
  await page.getByRole("button", { name: "Tasks in revision 1" }).click();
  await expect(revisionRow).toContainText("Investigate deliver");

  // Empty: no tasks recorded, so both surface and history say so.
  await openRun(page, "empty");
  await expect(detail).toContainText("No tasks were recorded.");
  await detailButton(detail, "History").click();
  await expect(detail).toContainText("REVISIONS");
  await expect(detail).toContainText("No task attempts yet.");
  await detailButton(detail, "Graph").click();
  await expect(detail).toContainText(
    "No tasks were recorded for this concert yet.",
  );

  // Planning: the coordinator notice replaces task work.
  await openRun(page, "planning");
  await expect(detail).toContainText(
    "The Conductor agent is planning this concert.",
  );
  await expect(detail).not.toContainText("No tasks were recorded.");
});

test("captures Tasks and Graph screenshots at the required viewports and themes", async ({
  page,
}) => {
  await mkdir(SHOTS, { recursive: true });
  const detail = page.getByTestId("run-detail");
  const snap = (name: string) =>
    page.screenshot({ path: resolve(SHOTS, name), fullPage: false });

  // 1440x900, light and dark, Tasks and Graph of the multi-task run.
  for (const [label, suffix] of [
    ["light", ""],
    ["dark", "&dark"],
  ] as const) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openRun(page, "multi", suffix);
    await snap(`wide-${label}-tasks-multi.png`);
    await detailButton(detail, "Graph").click();
    await expect(page.getByTestId("run-graph")).toBeVisible();
    await snap(`wide-${label}-graph-multi.png`);
  }

  // The user's one-task long-title case, wide and narrow.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openRun(page, "long-title");
  await snap("wide-light-tasks-long-title.png");
  await detailButton(detail, "Graph").click();
  await snap("wide-light-graph-long-title.png");

  // 390x844 (compact), light and dark.
  await page.setViewportSize({ width: 390, height: 844 });
  await openRun(page, "multi", "&global");
  await snap("narrow-light-tasks-multi.png");
  await detailButton(detail, "Graph").click();
  await snap("narrow-light-graph-multi.png");
  await openRun(page, "multi", "&global&dark");
  await snap("narrow-dark-tasks-multi.png");
  await detailButton(detail, "Graph").click();
  await snap("narrow-dark-graph-multi.png");
  await openRun(page, "long-title", "&global&dark");
  await snap("narrow-dark-tasks-long-title.png");

  // Remaining states as a narrow dark contact sheet.
  for (const fixture of [
    "blocked",
    "failed-checks",
    "waiting",
    "finishing",
    "empty",
    "planning",
  ]) {
    await openRun(page, fixture, "&global&dark");
    await snap(`narrow-dark-tasks-${fixture}.png`);
  }
});

test("768px viewport keeps every tab reachable and the graph internally scrollable", async ({
  page,
}) => {
  const detail = page.getByTestId("run-detail");
  await page.setViewportSize({ width: 768, height: 1024 });
  await openRun(page, "multi");
  expect(await noPageOverflow(page)).toBe(true);

  // Every navigation tab stays reachable and switches the view.
  for (const view of ["Tasks", "Graph", "Context", "History"]) {
    await detailButton(detail, view).click();
    await expect(page.getByTestId("run-detail")).toContainText(
      view === "Tasks" ? "Investigate api" : "",
    );
  }

  // History stays compact at the mid viewport: one row per attempt, no
  // repeated report summaries, and no horizontal page overflow.
  await detailButton(detail, "History").click();
  await expect(detail).toContainText("ATTEMPTS");
  await expect(page.getByTestId("history-attempt-1")).toContainText("api");
  await expect(detail).not.toContainText(
    "Collected both findings and recorded the uncertainty.",
  );
  expect(await noPageOverflow(page)).toBe(true);
  await detailButton(detail, "Tasks").click();
  expect(await page.getByTestId("run-task-api").textContent()).toContain(
    "Running",
  );
  await detailButton(detail, "Graph").click();
  await expect(page.getByTestId("run-graph")).toBeVisible();
  expect(await noPageOverflow(page)).toBe(true);

  // The graph canvas scrolls internally even though the page never does.
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
      node.scrollLeft = 240;
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

  // Keyboard activation still opens a worker from the graph.
  await page.getByTestId("run-node-api").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("preview-status")).toContainText("worker-api");

  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({
    path: resolve(SHOTS, "mid-768-graph-multi-light.png"),
    fullPage: false,
  });
});

test("enlarged zoom keeps content unclipped and tabs reachable", async ({
  page,
}) => {
  const detail = page.getByTestId("run-detail");
  await page.setViewportSize({ width: 1440, height: 900 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1.5 });
  await openRun(page, "multi");
  expect(await noPageOverflow(page)).toBe(true);
  // The action area wraps instead of pushing the tab strip off-screen.
  await expect(detailButton(detail, "Tasks")).toBeVisible();
  await expect(detailButton(detail, "History")).toBeVisible();
  for (const view of ["Tasks", "Graph", "History"]) {
    await detailButton(detail, view).click();
  }
  await detailButton(detail, "Graph").click();
  await expect(page.getByTestId("run-graph")).toBeVisible();
  // Graph still scrolls internally under zoom.
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
      node.scrollLeft = 200;
      return node.scrollLeft;
    });
  expect(canvas ?? 0).toBeGreaterThan(0);
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({
    path: resolve(SHOTS, "zoom-150-multi-graph-light.png"),
    fullPage: false,
  });
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
});

test("fixture runs serialize under the production run schema", async () => {
  const { runSchema } = await import("../../shared/concerts/models");
  const { fixtureRuns } = await import("../run-fixtures");
  expect(longSummary.split("\n").length).toBeGreaterThan(3);
  expect(longTaskTitle.length).toBeLessThanOrEqual(160);
  for (const [name, build] of Object.entries(fixtureRuns)) {
    const parsed = runSchema.safeParse(build());
    expect(parsed.success, `${name} must satisfy runSchema`).toBe(true);
  }
});
