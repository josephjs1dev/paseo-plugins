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

/** Geometry of a testid element within the symphony detail surface. */
function boxOf(page: Page, testId: string) {
  return page.getByTestId(testId).evaluate((element: HTMLElement) => {
    const { left, top, width, height } = element.getBoundingClientRect();
    return { left, top, width, height };
  });
}

test("Tasks, Graph and Context show the latest loop and can show an earlier one", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const detail = page.getByTestId("symphony-detail");
  await openSymphony(page, "loops");
  const trigger = page.getByTestId("loop-select");
  const listbox = page.getByTestId("loop-listbox");
  const option = (loop: number) => page.getByTestId(`loop-option-${loop}`);

  // The latest loop is selected by default; ui did not re-run in loop 3.
  await expect(trigger).toContainText("Loop 3 · succeeded · latest");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
  await expect(listbox).toHaveCount(0);
  await expect(page.getByTestId("loop-past-note")).toHaveCount(0);
  await expect(page.getByTestId("symphony-task-review")).toContainText(
    "Completed",
  );
  await expect(page.getByTestId("symphony-task-ui-carried")).toContainText(
    "result from loop 2",
  );
  // The first task card's geometry while closed, captured before anything
  // opens, so the floating list can be proven not to shift it.
  const taskCardBefore = await boxOf(page, "symphony-task-api");

  // Enter opens the inline list: newest loop first, the pick semibold and
  // ticked, older options plain.
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(listbox).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(option(3)).toHaveAttribute("aria-selected", "true");
  await expect(option(2).locator("svg")).toHaveCount(0);
  // The check is a rendered Lucide icon, not a glyph, and the list floats:
  // its left edge sits on the trigger's left edge, it starts just below the
  // trigger, and opening it moves nothing on the page.
  await expect(option(3).locator("svg")).toHaveCount(1);
  const [triggerBox, listboxBox] = await Promise.all([
    boxOf(page, "loop-select"),
    boxOf(page, "loop-listbox"),
  ]);
  expect(listboxBox.left).toBeGreaterThanOrEqual(triggerBox.left - 1);
  expect(listboxBox.left).toBeLessThanOrEqual(triggerBox.left + 1);
  expect(listboxBox.top).toBeGreaterThanOrEqual(
    triggerBox.top + triggerBox.height - 1,
  );
  expect(listboxBox.top).toBeLessThanOrEqual(
    triggerBox.top + triggerBox.height + 8,
  );
  expect(listboxBox.width).toBeGreaterThanOrEqual(triggerBox.width);
  const taskCardAfter = await boxOf(page, "symphony-task-api");
  expect(Math.abs(taskCardAfter.top - taskCardBefore.top)).toBeLessThanOrEqual(
    1,
  );
  expect(
    Math.abs(taskCardAfter.left - taskCardBefore.left),
  ).toBeLessThanOrEqual(1);
  await expect(option(3).getByText("Loop 3 · succeeded").first()).toHaveCSS(
    "font-weight",
    "600",
  );
  await expect(option(2).getByText("Loop 2 · needs changes").first()).toHaveCSS(
    "font-weight",
    "400",
  );
  await expect(option(2)).not.toContainText("✓");

  // Wide rows are 36px tall (44 on compact), with one elevation source: a
  // soft y-offset shadow, no zero-offset halo. An ordinary (unforced) mouse
  // hover reaches the row and paints the surface2 hover background.
  const rowHeight = await option(2).evaluate(
    (row: HTMLElement) => row.getBoundingClientRect().height,
  );
  expect(rowHeight).toBe(36);
  await option(2).hover();
  const hoverColor = await option(2).evaluate(
    (row: HTMLElement) => getComputedStyle(row).backgroundColor,
  );
  expect(hoverColor).not.toBe("rgba(0, 0, 0, 0)");
  const panelShadow = await listbox.evaluate((panel: HTMLElement) => {
    const style = getComputedStyle(panel);
    return { boxShadow: style.boxShadow, zIndex: style.zIndex };
  });
  expect(panelShadow.boxShadow).not.toBe("none");
  // y-offset soft shadow with a small opacity radius.
  expect(panelShadow.boxShadow).toMatch(/rgba\(0, 0, 0, 0\.12\) 0px 4px 12px/);
  expect(Number(panelShadow.zIndex)).toBeGreaterThan(0);

  // Escape from a focused option closes without choosing and returns focus to
  // the trigger, so the keyboard stays anchored.
  await page.keyboard.press("Tab");
  await expect(option(3)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(listbox).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.getByTestId("loop-past-note")).toHaveCount(0);

  // Space reopens; keyboard selection (Enter on a focused option) closes the
  // list, restores trigger focus, and follows the latest loop again.
  await page.keyboard.press("Space");
  await expect(listbox).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(option(3)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(listbox).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toContainText("Loop 3 · succeeded · latest");

  // Loop 1 shows the symphony as it ended, in Tasks and in the Graph.
  await page.keyboard.press("Space");
  await expect(listbox).toBeVisible();
  await option(1).click();
  await expect(listbox).toHaveCount(0);
  await expect(trigger).toContainText("Loop 1 · needs changes");
  await expect(page.getByTestId("loop-past-note")).toContainText(
    "Showing loop 1 as it ended. Loop 3 is the latest.",
  );
  await expect(page.getByTestId("symphony-task-review")).toContainText(
    "Needs changes",
  );
  await expect(page.getByTestId("symphony-task-ui-carried")).toHaveCount(0);
  await detailButton(detail, "Graph").click();
  await expect(page.getByTestId("symphony-node-review")).toContainText(
    "Needs changes",
  );

  // The floating list overlays the graph too: alignment holds, no graph node
  // moves, and an ordinary unforced hover and click reach the options.
  const nodeBefore = await boxOf(page, "symphony-node-review");
  await trigger.click();
  await expect(listbox).toBeVisible();
  const [graphTriggerBox, graphListBox] = await Promise.all([
    boxOf(page, "loop-select"),
    boxOf(page, "loop-listbox"),
  ]);
  expect(
    Math.abs(graphListBox.left - graphTriggerBox.left),
  ).toBeLessThanOrEqual(1);
  expect(graphListBox.top).toBeGreaterThanOrEqual(
    graphTriggerBox.top + graphTriggerBox.height - 1,
  );
  expect(graphListBox.top).toBeLessThanOrEqual(
    graphTriggerBox.top + graphTriggerBox.height + 8,
  );
  const nodeAfter = await boxOf(page, "symphony-node-review");
  expect(Math.abs(nodeAfter.top - nodeBefore.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(nodeAfter.left - nodeBefore.left)).toBeLessThanOrEqual(1);
  await option(3).hover();
  const graphHover = await option(3).evaluate(
    (row: HTMLElement) => getComputedStyle(row).backgroundColor,
  );
  expect(graphHover).not.toBe("rgba(0, 0, 0, 0)");
  await option(3).click();
  await expect(listbox).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toContainText("Loop 3 · succeeded · latest");

  // Context explains why a later loop started; loop 1 has only the goal.
  await detailButton(detail, "Context").click();
  await expect(page.getByTestId("loop-context-2")).toHaveCount(0);
  await trigger.click();
  await expect(listbox).toBeVisible();
  await option(2).click();
  const context = page.getByTestId("loop-context-2");
  await expect(context).toContainText("WHY LOOP 2 STARTED");
  await expect(context).toContainText("Fix review findings F1 and F2");
  await expect(context).toContainText("Reopened api");

  // Escape closes the list without choosing and refocuses the trigger.
  await trigger.click();
  await expect(listbox).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(listbox).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("[data-testid='loop-select'] svg")).toHaveCount(1);

  // Back to following the latest loop.
  await detailButton(detail, "Show latest loop").click();
  await expect(trigger).toContainText("Loop 3 · succeeded · latest");
  await expect(page.getByTestId("loop-past-note")).toHaveCount(0);
  expect(await noPageOverflow(page)).toBe(true);

  // Compact width keeps the dropdown on one line, closed and open, with the
  // 44px trigger touch target. Return to Tasks first so the first task card
  // is on the surface.
  await detailButton(detail, "Tasks").click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await noPageOverflow(page)).toBe(true);
  const compactTrigger = await trigger.boundingBox();
  expect(compactTrigger?.height ?? 0).toBeGreaterThanOrEqual(44);
  const compactCardBefore = await boxOf(page, "symphony-task-api");
  await trigger.click();
  await expect(listbox).toBeVisible();
  expect(await noPageOverflow(page)).toBe(true);
  const compactRowsHeights = await Promise.all(
    [1, 2, 3].map(async (loop) =>
      page
        .getByTestId(`loop-option-${loop}`)
        .evaluate((row: HTMLElement) => row.getBoundingClientRect().height),
    ),
  );
  for (const height of compactRowsHeights) {
    expect(height).toBe(44);
  }
  const compactTriggerBox = await boxOf(page, "loop-select");
  const compactListBox = await boxOf(page, "loop-listbox");
  expect(
    Math.abs(compactListBox.left - compactTriggerBox.left),
  ).toBeLessThanOrEqual(1);
  expect(compactListBox.top).toBeGreaterThanOrEqual(
    compactTriggerBox.top + compactTriggerBox.height - 1,
  );
  expect(compactListBox.top).toBeLessThanOrEqual(
    compactTriggerBox.top + compactTriggerBox.height + 8,
  );
  const compactCardAfter = await boxOf(page, "symphony-task-api");
  expect(
    Math.abs(compactCardAfter.top - compactCardBefore.top),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(compactCardAfter.left - compactCardBefore.left),
  ).toBeLessThanOrEqual(1);
  await option(3).hover();
  const compactHover = await option(3).evaluate(
    (row: HTMLElement) => getComputedStyle(row).backgroundColor,
  );
  expect(compactHover).not.toBe("rgba(0, 0, 0, 0)");
  await option(3).click();
  await expect(listbox).toHaveCount(0);
  await expect(trigger).toBeFocused();

  // The floating list overlays the compact graph too: alignment holds, a
  // graph node does not move, and an ordinary hover and click reach options.
  await detailButton(detail, "Graph").click();
  const compactNodeBefore = await boxOf(page, "symphony-node-review");
  await trigger.click();
  await expect(listbox).toBeVisible();
  expect(await noPageOverflow(page)).toBe(true);
  const [compactGraphTrigger, compactGraphList] = await Promise.all([
    boxOf(page, "loop-select"),
    boxOf(page, "loop-listbox"),
  ]);
  expect(
    Math.abs(compactGraphList.left - compactGraphTrigger.left),
  ).toBeLessThanOrEqual(1);
  expect(compactGraphList.top).toBeGreaterThanOrEqual(
    compactGraphTrigger.top + compactGraphTrigger.height - 1,
  );
  expect(compactGraphList.top).toBeLessThanOrEqual(
    compactGraphTrigger.top + compactGraphTrigger.height + 8,
  );
  const compactNodeAfter = await boxOf(page, "symphony-node-review");
  expect(
    Math.abs(compactNodeAfter.top - compactNodeBefore.top),
  ).toBeLessThanOrEqual(1);
  await option(2).hover();
  const compactGraphHover = await option(2).evaluate(
    (row: HTMLElement) => getComputedStyle(row).backgroundColor,
  );
  expect(compactGraphHover).not.toBe("rgba(0, 0, 0, 0)");
  await option(2).click();
  await expect(listbox).toHaveCount(0);
  await expect(trigger).toBeFocused();

  // History always lists every loop, so it has no selector.
  await detailButton(detail, "History").click();
  await expect(page.getByTestId("loop-selector")).toHaveCount(0);
});

test("needs changes, loop headers, findings, and unresolved stay readable", async ({
  page,
}) => {
  const detail = page.getByTestId("symphony-detail");

  // A needs-changes implementation task: amber state dot and label, distinct
  // from the danger red of the failed check line beneath it.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSymphony(page, "needs-changes");
  const apiCard = page.getByTestId("symphony-task-api");
  await expect(apiCard).toContainText("Needs changes");
  await expect(apiCard).toContainText(
    "✕ contract test: expected 400 for an unknown concert, received 500",
  );
  const dotColor = await apiCard.evaluate((element) => {
    for (const dot of Array.from(element.querySelectorAll("div"))) {
      const style = getComputedStyle(dot);
      if (style.width === "6px" && style.height === "6px") {
        return style.backgroundColor;
      }
    }
    return null;
  });
  expect(dotColor).toBe("rgb(148, 96, 18)");
  await apiCard.getByTestId("symphony-task-findings-api").click();
  await expect(apiCard).toContainText("✕ Blocking · F1");
  await expect(apiCard).toContainText("server/symphonies/execution.ts:112");
  await expect(apiCard).toContainText("Map SymphonyError 404 cases");
  // The score graph and legend carry the same state.
  await detailButton(detail, "Graph").click();
  await expect(page.getByTestId("symphony-node-api")).toContainText(
    "Needs changes",
  );
  await expect(page.getByTestId("symphony-graph")).toContainText(
    "Needs changes",
  );

  // The full loop flow grouped in History: loop verdicts with blocking
  // counts, reopen reasons, the recorded user approval, and reopened
  // attempts showing the findings they address.
  await openSymphony(page, "loops");
  await expect(detail).toContainText(
    "Loops 1 and 2 needed changes; the user approved loop 3 past the budget",
  );
  await detailButton(detail, "History").click();
  const loop1 = page.getByTestId("history-loop-1");
  await expect(loop1).toContainText("Loop 1");
  await expect(loop1).toContainText("needs changes (2 blocking)");
  const loop2 = page.getByTestId("history-loop-2");
  await expect(loop2).toContainText("Loop 2");
  await expect(loop2).toContainText("needs changes (1 blocking)");
  await expect(loop2).toContainText(
    "Reopened because: Fix review findings F1 and F2",
  );
  const loop3 = page.getByTestId("history-loop-3");
  await expect(loop3).toContainText("Loop 3");
  await expect(loop3).toContainText("succeeded");
  await expect(loop3).toContainText(
    'User approved loop 3: "Yes, run one more loop to fix F3."',
  );
  await expect(loop3).toContainText(
    "Reopened because: Fix the follow-up finding F3 found while re-checking",
  );
  // Grouped rows are always numbered so the same task across loops keeps
  // unique test IDs — per task, not globally — and the review re-check links
  // the findings it addresses.
  await expect(page.getByTestId("history-attempt-api-1")).toContainText(
    "Attempt 1",
  );
  const reviewRecheck = page.getByTestId("history-attempt-review-2");
  await expect(reviewRecheck).toContainText("Attempt 2");
  await expect(reviewRecheck).toContainText("Reopened — Confirm F1 and F2");
  await expect(reviewRecheck).toContainText("✕ Blocking · F1");
  await expect(reviewRecheck).toContainText("on api");
  const followUp = page.getByTestId("history-attempt-api-3");
  await expect(followUp).toContainText("Attempt 3");
  await expect(followUp).toContainText("✕ Blocking · F3");
  await expect(followUp).toContainText("orchestration.ts:1223");
  const finalReview = page.getByTestId("history-attempt-review-3");
  await expect(finalReview).toContainText("Attempt 3");
  await expect(finalReview).toContainText("Completed");
  expect(await noPageOverflow(page)).toBe(true);

  // Single-loop symphonies keep their ungrouped history: no loop headers.
  await openSymphony(page, "recovery");
  await detailButton(detail, "History").click();
  await expect(detail.getByTestId("history-task-repair")).toBeVisible();
  await expect(detail.getByText("Loop 1")).toHaveCount(0);

  // A symphony finished with unresolved work lists every item the user left
  // open, on the detail surface.
  await openSymphony(page, "unresolved");
  const unresolved = page.getByTestId("symphony-unresolved");
  await expect(unresolved).toContainText("UNRESOLVED");
  await expect(unresolved).toContainText(
    "api#F1 — Needs a product decision on the 400 shape.",
  );
  await expect(unresolved).toContainText(
    "api — User chose to stop instead of looping.",
  );
  const apiStop = page.getByTestId("symphony-task-api");
  await expect(apiStop).toContainText("Needs changes");
  await expect(apiStop).toContainText("Findings 1");
  expect(await noPageOverflow(page)).toBe(true);
  // Compact layout: the findings panel stays inside 390px.
  await page.setViewportSize({ width: 390, height: 844 });
  await openSymphony(page, "needs-changes", "&global");
  const narrowApi = page.getByTestId("symphony-task-api");
  await narrowApi.getByTestId("symphony-task-findings-api").click();
  await expect(narrowApi).toContainText("✕ Blocking · F1");
  await expect(narrowApi).toContainText("on api");
  expect(await noPageOverflow(page)).toBe(true);
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

  // A settled attempt shows the paths it changed in its write scope as one
  // muted Changed line; an uncapped list names every path, a capped list adds
  // "+ more". Attempts without recorded changes keep no Changed line.
  await detailButton(detail, "Tasks").click();
  await openSymphony(page, "changed-paths");
  await detailButton(detail, "History").click();
  const changedFirst = page.getByTestId("history-attempt-repair-1");
  await expect(changedFirst).toContainText(
    "Changed: server/rpc.ts, shared/schema.ts",
  );
  const changedSecond = page.getByTestId("history-attempt-repair-2");
  await expect(changedSecond).toContainText("retry · new agent");
  await expect(changedSecond).toContainText(
    "Changed: shared/schema.ts, server/rpc.ts, server/handlers/export.ts",
  );
  await expect(changedSecond).toContainText("+ more");
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
    "needs-changes",
    "loops",
    "unresolved",
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
