import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { longSummary, longTaskTitle } from "../symphony-fixtures";

/**
 * Integration verification for the Tasks and Graph UI.
 *
 * Every fixture scenario in tests/preview/symphonies.ts is exercised end-to-end
 * through the real preview surface, and representative Tasks/Graph screenshots
 * are written under .artifacts/reviews/20261006-conductor-symphony-ui/screenshots/
 * for visual inspection. Only fixtures and tests live here; production client
 * code is not touched by this spec.
 */

const SHOTS = fileURLToPath(
  new URL(
    "../../../.artifacts/reviews/20261006-conductor-symphony-ui/screenshots",
    import.meta.url,
  ),
);

async function openSymphony(page: Page, fixture: string, extra = "") {
  await page.goto(`/?symphonies&symphony-fixture=${fixture}${extra}`);
  await page.getByRole("tab", { name: "Symphonies", exact: true }).click();
  await page
    .getByRole("button", { name: /^Open symphony:/ })
    .first()
    .click();
  await expect(page.getByTestId("symphony-detail")).toBeVisible();
}

/** Symphony-detail controls share names with queue rows, so stay inside one detail surface. */
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
  const detail = page.getByTestId("symphony-detail");

  // One-task long-title case: the full title stays visible on the card and in
  // the graph selection label even though the node body truncates it.
  await openSymphony(page, "long-title");
  await expect(page.getByTestId("symphony-task-migration")).toContainText(
    longTaskTitle,
  );
  await expect(page.getByTestId("symphony-task-migration")).toContainText(
    "Running",
  );
  await detailButton(detail, "Graph").click();
  const migration = page.getByTestId("symphony-node-migration");
  await expect(migration).toContainText("Running");
  await expect(migration).toHaveAttribute(
    "aria-label",
    new RegExp(longTaskTitle),
  );
  await migration.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("symphony-graph-selection")).toContainText(
    longTaskTitle,
  );

  // Multi-task score: running, waiting, blocked, completed + failed check,
  // finishing, ready, and a same-layer resource conflict edge.
  await openSymphony(page, "multi");
  await expect(page.getByTestId("symphony-task-api")).toContainText("Running");
  await expect(page.getByTestId("symphony-task-ui")).toContainText(
    "Waiting · waiting for api",
  );
  await expect(page.getByTestId("symphony-task-backend")).toContainText(
    "Blocked",
  );
  await expect(page.getByTestId("symphony-task-backend")).toContainText(
    "Confirm the pagination compatibility requirement",
  );
  await expect(page.getByTestId("symphony-task-collect")).toContainText(
    "Completed",
  );
  await expect(page.getByTestId("symphony-task-collect")).toContainText(
    "✕ Regression suite: Offset export test still red.",
  );
  await expect(page.getByTestId("symphony-task-ship")).toContainText(
    "Finishing",
  );
  const collect = page.getByTestId("symphony-task-collect");
  await detailButton(collect, "Evidence 2").click();
  await expect(collect).toContainText(
    "Reviewed the API cursor implementation and the UI fixtures.",
  );
  await detailButton(collect, "Checks 2/3 passed · 1 failed").click();
  await expect(collect).toContainText("✓ Passed");
  await expect(collect).toContainText("API cursor coverage");
  await detailButton(detail, "Graph").click();
  const graph = page.getByTestId("symphony-graph");
  await expect(graph).toBeVisible();
  await expect(page.getByTestId("symphony-node-api")).toContainText("Running");
  await expect(page.getByTestId("symphony-node-ui")).toHaveAttribute(
    "aria-label",
    /Waits for api/,
  );
  await expect(page.getByTestId("symphony-node-collect")).toContainText(
    "Completed",
  );
  await expect(page.getByTestId("symphony-node-ship")).toContainText(
    "Finishing",
  );
  await expect(
    page.getByTestId("symphony-edge-api-ui-dependency-0"),
  ).toBeVisible();
  await expect(
    page.getByTestId(/symphony-edge-.*-conflict-0/).first(),
  ).toBeVisible();

  // Blocked symphony with an actionable message.
  await openSymphony(page, "blocked");
  await expect(page.getByTestId("symphony-task-export")).toContainText(
    "Blocked",
  );
  await expect(detail).toContainText(
    "Confirm the pagination compatibility requirement in the source conversation.",
  );

  // Failed checks survive default collapsed disclosure and Show more keeps the
  // full five-line summary reachable instead of discarding text.
  await openSymphony(page, "failed-checks");
  await expect(page.getByTestId("symphony-task-review")).toContainText(
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
    "The full evidence trail is recorded in the symphony history.",
  );

  // Waiting: api is completed so collect still waits on the unfinished ui.
  await openSymphony(page, "waiting");
  await expect(page.getByTestId("symphony-task-api")).toContainText(
    "Completed",
  );
  await expect(page.getByTestId("symphony-task-ui")).toContainText("Ready");
  await expect(page.getByTestId("symphony-task-collect")).toContainText(
    "Waiting · waiting for ui",
  );

  // Finishing: a reported completion with an unsettled agent launch. History
  // holds one row per task, and a task with one attempt needs no attempt
  // number; it never repeats the report summary that lives on the task card.
  await openSymphony(page, "finishing");
  await expect(page.getByTestId("symphony-task-deliver")).toContainText(
    "Finishing",
  );
  await detailButton(detail, "History").click();
  await expect(detail).toContainText("HISTORY");
  await expect(detail).not.toContainText("REVISIONS");
  const attemptRow = page.getByTestId("history-task-deliver");
  await expect(attemptRow).toContainText("deliver");
  await expect(attemptRow).toContainText("Finishing");
  await expect(attemptRow).toContainText("5m");
  await expect(attemptRow).toContainText("Attempt 1");
  await expect(attemptRow).toContainText("Started ");
  await expect(attemptRow).not.toContainText(
    "Delivery package handed to the source.",
  );
  await attemptRow
    .getByRole("button", { name: "Open agent · deliver" })
    .click();
  await expect(page.getByTestId("preview-status")).toContainText(
    "worker-deliver",
  );
  // The Context tab states the accepted plan once;
  // nothing grew scope, so no Conductor addition line appears.
  const finishPlan = page.getByTestId("symphony-plan");
  await detailButton(detail, "Context").click();
  await expect(finishPlan).toContainText("Plan accepted");
  await expect(finishPlan).toContainText("1 task");
  await expect(page.getByTestId("symphony-plan-added-writes")).toHaveCount(0);

  // Empty: no tasks recorded, so both surface and history say so.
  await openSymphony(page, "empty");
  await expect(detail).toContainText("No tasks were recorded.");
  await detailButton(detail, "History").click();
  await expect(detail).not.toContainText("REVISIONS");
  await expect(detail).toContainText("No task attempts yet.");
  await detailButton(detail, "Graph").click();
  await expect(detail).toContainText(
    "No tasks were recorded for this symphony yet.",
  );

  // Planning: the conductor notice replaces task work.
  await openSymphony(page, "planning");
  await expect(detail).toContainText(
    "The Conductor agent is planning this symphony.",
  );
  await expect(detail).not.toContainText("No tasks were recorded.");
});

test("failed reports show diagnosis, granted writes, and reused agents", async ({
  page,
}) => {
  const detail = page.getByTestId("symphony-detail");

  // The recovery fixture: a failed report with a structured diagnosis and an
  // attempt that already holds one server-granted write.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSymphony(page, "recovery");
  const repair = page.getByTestId("symphony-task-repair");
  await expect(repair).toContainText("✕ typecheck: TS2345 in server/rpc.ts:41");

  // Diagnosis stays collapsed until opened; then the fix rounds, suspected
  // cause, need, and requested paths all render in one inset panel.
  await repair.getByTestId("symphony-task-diagnosis-repair").click();
  await expect(repair).toContainText("Narrowed the input type");
  await expect(repair).toContainText("2. Regenerated the schema");
  await expect(repair).toContainText("shared/schema.ts exports the old shape");
  await expect(repair).toContainText("Needs wider write scope");
  await expect(repair).toContainText("shared/schema.ts");

  // Granted writes with their reasons stay collapsed until opened.
  await expect(repair).not.toContainText("Typecheck reads the exported schema");
  await repair.getByTestId("symphony-task-granted-repair").click();
  await expect(repair).toContainText("Typecheck reads the exported schema");
  expect(await noPageOverflow(page)).toBe(true);

  // The history shows the widened scope on the task's single attempt row.
  await detailButton(detail, "History").click();
  const repairRow = page.getByTestId("history-task-repair");
  await expect(repairRow).toContainText("widened: shared/schema.ts");
  await expect(repairRow).toContainText(
    '"Typecheck reads the exported schema"',
  );
  await expect(repairRow).not.toContainText("Effective writes");

  // Two failed attempts of one task sharing an agent: the task row counts the
  // attempts, each attempt row says how the retry ran, and only the
  // second attempt shows the widened path.
  await detailButton(detail, "Tasks").click();
  await openSymphony(page, "agent-reuse");
  await expect(page.getByTestId("symphony-task-repair")).toContainText(
    "same agent across 2 attempts",
  );
  expect(await noPageOverflow(page)).toBe(true);
  await detailButton(detail, "History").click();
  const reuseRow = page.getByTestId("history-task-repair");
  await expect(reuseRow).toContainText("2 attempts");
  const reuseFirst = page.getByTestId("history-attempt-repair-1");
  await expect(reuseFirst).toContainText("Attempt 1");
  await expect(reuseFirst).not.toContainText("retry ·");
  await expect(reuseFirst).not.toContainText("widened");
  const reuseSecond = page.getByTestId("history-attempt-repair-2");
  await expect(reuseSecond).toContainText("Attempt 2");
  await expect(reuseSecond).toContainText("retry · same agent");
  await expect(reuseSecond).toContainText("widened: shared/schema.ts");

  // A retried task whose Conductor `addWrites` is recorded on the retry
  // attempt: the first attempt widened its scope, the fresh attempt on a new
  // agent carries the path the Conductor added, with its reason.
  await detailButton(detail, "Tasks").click();
  await openSymphony(page, "retry-added");
  await detailButton(detail, "History").click();
  const addedRow = page.getByTestId("history-task-repair");
  await expect(addedRow).toContainText("2 attempts");
  const addedFirst = page.getByTestId("history-attempt-repair-1");
  await expect(addedFirst).toContainText("widened: shared/schema.ts");
  await expect(addedFirst).not.toContainText("shared/helper.ts");
  const addedSecond = page.getByTestId("history-attempt-repair-2");
  await expect(addedSecond).toContainText("retry · new agent");
  await expect(addedSecond).toContainText(
    '+ shared/helper.ts added by Conductor — "needs the exported type"',
  );
  expect(await noPageOverflow(page)).toBe(true);

  // A legacy record with an addWrites revision: the Context tab names the
  // grown task, and no History row can attribute the paths to an attempt.
  await detailButton(detail, "Tasks").click();
  await openSymphony(page, "recovery-retry");
  await detailButton(detail, "Context").click();
  await expect(page.getByTestId("symphony-plan")).toContainText(
    "Plan accepted",
  );
  await expect(page.getByTestId("symphony-plan-added-writes")).toContainText(
    "Write scope later added by the Conductor to: repair",
  );
  await detailButton(detail, "History").click();
  const widened = page.getByTestId("history-attempt-repair-1");
  await expect(widened).toContainText("widened: shared/schema.ts");
  await expect(widened).not.toContainText("shared/helper.ts");
  await widened.getByTestId("history-diagnosis-repair-1").click();
  await expect(widened).toContainText("Narrowed the input type");
  const legacyRetry = page.getByTestId("history-attempt-repair-2");
  await expect(legacyRetry).toContainText("retry · new agent");
  await expect(legacyRetry).not.toContainText("shared/helper.ts");
  expect(await noPageOverflow(page)).toBe(true);

  // Compact layout: the opened panels stay inside a 390px viewport.
  await page.setViewportSize({ width: 390, height: 844 });
  await openSymphony(page, "recovery", "&global");
  const narrowRepair = page.getByTestId("symphony-task-repair");
  await narrowRepair.getByTestId("symphony-task-diagnosis-repair").click();
  await narrowRepair.getByTestId("symphony-task-granted-repair").click();
  await expect(narrowRepair).toContainText("Needs wider write scope");
  await expect(narrowRepair).toContainText(
    "Typecheck reads the exported schema",
  );
  expect(await noPageOverflow(page)).toBe(true);
});

test("captures Tasks and Graph screenshots at the required viewports and themes", async ({
  page,
}) => {
  await mkdir(SHOTS, { recursive: true });
  const detail = page.getByTestId("symphony-detail");
  const snap = (name: string) =>
    page.screenshot({ path: resolve(SHOTS, name), fullPage: false });

  // 1440x900, light and dark, Tasks and Graph of the multi-task symphony.
  for (const [label, suffix] of [
    ["light", ""],
    ["dark", "&dark"],
  ] as const) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSymphony(page, "multi", suffix);
    await snap(`wide-${label}-tasks-multi.png`);
    await detailButton(detail, "Graph").click();
    await expect(page.getByTestId("symphony-graph")).toBeVisible();
    await snap(`wide-${label}-graph-multi.png`);
  }

  // The user's one-task long-title case, wide and narrow.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSymphony(page, "long-title");
  await snap("wide-light-tasks-long-title.png");
  await detailButton(detail, "Graph").click();
  await snap("wide-light-graph-long-title.png");

  // 390x844 (compact), light and dark.
  await page.setViewportSize({ width: 390, height: 844 });
  await openSymphony(page, "multi", "&global");
  await snap("narrow-light-tasks-multi.png");
  await detailButton(detail, "Graph").click();
  await snap("narrow-light-graph-multi.png");
  await openSymphony(page, "multi", "&global&dark");
  await snap("narrow-dark-tasks-multi.png");
  await detailButton(detail, "Graph").click();
  await snap("narrow-dark-graph-multi.png");
  await openSymphony(page, "long-title", "&global&dark");
  await snap("narrow-dark-tasks-long-title.png");

  // Remaining states as a narrow dark contact sheet.
  for (const fixture of [
    "blocked",
    "failed-checks",
    "waiting",
    "finishing",
    "recovery",
    "empty",
    "planning",
  ]) {
    await openSymphony(page, fixture, "&global&dark");
    await snap(`narrow-dark-tasks-${fixture}.png`);
  }
});

test("768px viewport keeps every tab reachable and the graph internally scrollable", async ({
  page,
}) => {
  const detail = page.getByTestId("symphony-detail");
  await page.setViewportSize({ width: 768, height: 1024 });
  await openSymphony(page, "multi");
  expect(await noPageOverflow(page)).toBe(true);

  // Every navigation tab stays reachable and switches the view.
  for (const view of ["Tasks", "Graph", "Context", "History"]) {
    await detailButton(detail, view).click();
    await expect(page.getByTestId("symphony-detail")).toContainText(
      view === "Tasks" ? "Investigate api" : "",
    );
  }

  // History stays compact at the mid viewport: one section per task, no
  // repeated report summaries, and no horizontal page overflow.
  await detailButton(detail, "History").click();
  await expect(detail).toContainText("HISTORY");
  await expect(page.getByTestId("history-task-api")).toContainText("api");
  await expect(detail).not.toContainText(
    "Collected both findings and recorded the uncertainty.",
  );
  expect(await noPageOverflow(page)).toBe(true);
  await detailButton(detail, "Tasks").click();
  expect(await page.getByTestId("symphony-task-api").textContent()).toContain(
    "Running",
  );
  await detailButton(detail, "Graph").click();
  await expect(page.getByTestId("symphony-graph")).toBeVisible();
  expect(await noPageOverflow(page)).toBe(true);

  // The graph canvas scrolls internally even though the page never does.
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

  // Keyboard activation still opens a task agent from the graph.
  await page.getByTestId("symphony-node-api").focus();
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
  const detail = page.getByTestId("symphony-detail");
  await page.setViewportSize({ width: 1440, height: 900 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1.5 });
  await openSymphony(page, "multi");
  expect(await noPageOverflow(page)).toBe(true);
  // The action area wraps instead of pushing the tab strip off-screen.
  await expect(detailButton(detail, "Tasks")).toBeVisible();
  await expect(detailButton(detail, "History")).toBeVisible();
  for (const view of ["Tasks", "Graph", "History"]) {
    await detailButton(detail, view).click();
  }
  await detailButton(detail, "Graph").click();
  await expect(page.getByTestId("symphony-graph")).toBeVisible();
  // Graph still scrolls internally under zoom.
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

test("fixture symphonies serialize under the production symphony schema", async () => {
  const { symphonySchema } = await import("../../shared/symphonies/models");
  const { fixtureSymphonies } = await import("../symphony-fixtures");
  expect(longSummary.split("\n").length).toBeGreaterThan(3);
  expect(longTaskTitle.length).toBeLessThanOrEqual(160);
  for (const [name, build] of Object.entries(fixtureSymphonies)) {
    const parsed = symphonySchema.safeParse(build());
    expect(parsed.success, `${name} must satisfy symphonySchema`).toBe(true);
  }
});
