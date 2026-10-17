import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Focused graph behavior checks: selecting a score node stays in Podium and
 * highlights only its direct relationships; opening the task agent is a
 * separate explicit action in the selection panel; the compact heading counts
 * the displayed score; a short canvas hugs its content while a large score
 * keeps scrolling inside the graph frame; screenshots record the rendered
 * evidence for review.
 */

const EVIDENCE = fileURLToPath(
  new URL("../../../.artifacts/reviews/20261013-podium-graph", import.meta.url),
);

/** Symphony-detail controls share names with queue rows; stay inside one detail. */
function detailButton(detail: ReturnType<Page["getByTestId"]>, name: string) {
  return detail.getByRole("button", { name, exact: true }).first();
}

async function openGraph(page: Page, fixture = "", suffix = "") {
  await page.goto(
    `/?symphonies${fixture ? `&symphony-fixture=${fixture}` : ""}${suffix}`,
  );
  await page.getByRole("tab", { name: "Symphonies", exact: true }).click();
  await page
    .getByRole("button", { name: /^Open symphony:/ })
    .first()
    .click();
  const detail = page.getByTestId("symphony-detail");
  await expect(detail).toBeVisible();
  await detailButton(detail, "Graph").click();
  await expect(page.getByTestId("symphony-graph")).toBeVisible();
  return detail;
}

/** First scrollable ancestor of a graph node: the graph canvas itself. */
function scrollCanvas(page: Page, nodeTestId: string) {
  return page.getByTestId(nodeTestId).evaluate((element: HTMLElement) => {
    let node: HTMLElement | null = element;
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node);
      if (
        (style.overflowX === "auto" || style.overflowX === "scroll") &&
        node.clientWidth > 0
      ) {
        return {
          clientWidth: node.clientWidth,
          scrollWidth: node.scrollWidth,
        };
      }
      node = node.parentElement;
    }
    return null;
  });
}

/** Bounding height of one graph node frame. */
function nodeHeight(page: Page, taskId: string) {
  return page
    .getByTestId(`symphony-node-${taskId}`)
    .evaluate((element: HTMLElement) => element.getBoundingClientRect().height);
}

/**
 * Metrics of a worker group's model text: the last child of the group row
 * after the harness mark. `scrollWidth > clientWidth` means the label is
 * clamped by numberOfLines and truncated. `trailingGap` is the distance from
 * the group's right edge to its node frame's right edge (12px node padding
 * when the group sits fully trailing).
 */
function workerTextMetrics(page: Page, taskId: string) {
  return page
    .getByTestId(`symphony-worker-${taskId}`)
    .evaluate((element: HTMLElement) => {
      const text = element.children[element.children.length - 1];
      const group = element.getBoundingClientRect();
      const node = element.closest('[data-testid^="symphony-node-"]');
      return {
        scrollWidth: text instanceof HTMLElement ? text.scrollWidth : 0,
        clientWidth: text instanceof HTMLElement ? text.clientWidth : 0,
        groupWidth: group.width,
        trailingGap: node
          ? node.getBoundingClientRect().right - group.right
          : -1,
      };
    });
}

function edgeOpacity(page: Page, testId: string) {
  return page
    .getByTestId(testId)
    .evaluate((element: HTMLElement) => getComputedStyle(element).opacity);
}

test("pressing a node selects it without navigating; Open agent is explicit", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const detail = await openGraph(page);
  // Give the api task a live attempt so its panel can offer navigation.
  await page
    .getByRole("button", { name: "Source claims task", exact: true })
    .click();
  await detailButton(detail, "Graph").click();
  const api = page.getByTestId("symphony-node-api");
  await expect(api).toHaveAttribute("aria-label", /^Select task api — /);
  await expect(
    page.getByTestId("symphony-edge-api-collect-dependency-0"),
  ).toBeVisible();
  await expect(
    page.getByTestId("symphony-edge-ui-collect-dependency-0"),
  ).toBeVisible();
  await api.click();
  const selection = page.getByTestId("symphony-graph-selection");
  await expect(selection).toBeVisible();
  await expect(page.getByTestId("symphony-graph-selection-title")).toHaveText(
    "Selected api: Investigate api",
  );
  await expect(selection).toContainText("Running");
  // Selection leaves the user in Podium: no agent opens on the press.
  await expect(page.getByTestId("preview-status")).toContainText("sends:0");
  expect(await page.getByTestId("preview-status").textContent()).not.toContain(
    "worker-api",
  );
  // Direct edges read at full strength; unrelated edges fade but stay visible.
  expect(
    await edgeOpacity(page, "symphony-edge-api-collect-dependency-0"),
  ).toBe("1");
  // React Native's host maps the selected state onto the accessible name
  // rather than an aria-selected attribute on a button-role node.
  await expect(api).toHaveAttribute("aria-label", /Selected\.$/);
  const collect = page.getByTestId("symphony-node-collect");
  // The directly connected node gets an accent frame too; unrelated ui keeps
  // its ordinary border.
  const borders = await page.evaluate(() => {
    const read = (testId: string) => {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      return element ? getComputedStyle(element).borderTopColor : null;
    };
    return {
      connected: read("symphony-node-collect"),
      unrelated: read("symphony-node-ui"),
    };
  });
  expect(borders.connected).not.toBeNull();
  expect(borders.connected).not.toBe(borders.unrelated);
  // Keyboard selection works; Space activates the node like the brief's
  // Enter/Space contract, and the panel follows the newest selection.
  await page.getByTestId("symphony-node-ui").press("Enter");
  await expect(page.getByTestId("symphony-graph-selection-title")).toHaveText(
    "Selected ui: Investigate ui",
  );
  await page.getByTestId("symphony-node-collect").press(" ");
  await expect(page.getByTestId("symphony-graph-selection-title")).toHaveText(
    "Selected collect: Investigate collect",
  );
  await expect(selection).toContainText("Waits for api, ui");
  await collect.press("Enter");
  await expect(page.getByTestId("symphony-graph-selection-title")).toHaveText(
    "Selected collect: Investigate collect",
  );
  // The panel carries the selection back to the agent-bearing task ready for
  // the explicit Open agent action: collect has no agent of its own.
  await expect(page.getByTestId("symphony-graph-open-agent")).toHaveCount(0);
  await api.press("Enter");
  await expect(page.getByTestId("symphony-graph-selection-title")).toHaveText(
    "Selected api: Investigate api",
  );
  await page.getByTestId("symphony-graph-open-agent").click();
  await expect(page.getByTestId("preview-status")).toContainText("worker-api");
});

test("a selected task without an available agent offers no navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGraph(page);
  const selection = page.getByTestId("symphony-graph-selection");
  // No claim has been recorded: selecting ready tasks must not offer a
  // nonexistent agent, and the failed-launch note stays hidden too.
  await page.getByTestId("symphony-node-api").click();
  await expect(selection).toBeVisible();
  await expect(page.getByTestId("symphony-graph-open-agent")).toHaveCount(0);
  await expect(selection).not.toContainText("launch failed");
  // Keyboard selection stays available: Enter on the collect node.
  await page.getByTestId("symphony-node-collect").press("Enter");
  await expect(page.getByTestId("symphony-graph-selection-title")).toHaveText(
    "Selected collect: Investigate collect",
  );
});

test("selection resets when the shown score drops the task and never revives", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGraph(page, "loop-scores");
  const heading = page.getByTestId("symphony-graph-heading");
  const selection = page.getByTestId("symphony-graph-selection");
  // The latest loop (2) appended api to the score: ui and api are both shown.
  await expect(heading).toContainText("2 tasks");
  await page.getByTestId("symphony-node-api").click();
  await expect(page.getByTestId("symphony-graph-selection-title")).toHaveText(
    "Selected api: Investigate api",
  );
  // Loop 1's score is [ui] only: the api pick must actually reset, so the
  // panel disappears entirely.
  await page.getByTestId("loop-select").click();
  await page.getByTestId("loop-option-1").click();
  await expect(heading).toContainText("1 task");
  await expect(selection).toHaveCount(0);
  // Returning to the appended task's loop must not revive the stored pick:
  // api is shown again, but no selection exists until a new activation.
  await page
    .getByRole("button", { name: "Show latest loop", exact: true })
    .click();
  await expect(heading).toContainText("2 tasks");
  await expect(selection).toHaveCount(0);
  // Activation still selects after an invalidation round trip.
  await page.getByTestId("symphony-node-ui").click();
  await expect(page.getByTestId("symphony-graph-selection-title")).toHaveText(
    "Selected ui: Investigate ui",
  );
  // A changed score that still contains the picked task preserves the valid
  // selection across the same loop switches.
  await page.getByTestId("loop-select").click();
  await page.getByTestId("loop-option-1").click();
  await expect(heading).toContainText("1 task");
  await expect(page.getByTestId("symphony-graph-selection-title")).toHaveText(
    "Selected ui: Investigate ui",
  );
  await page
    .getByRole("button", { name: "Show latest loop", exact: true })
    .click();
  await expect(page.getByTestId("symphony-graph-selection-title")).toHaveText(
    "Selected ui: Investigate ui",
  );
});

test("the heading counts the displayed score and the legend lists present states", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGraph(page, "multi");
  const heading = page.getByTestId("symphony-graph-heading");
  await expect(heading).toContainText("8 tasks");
  await expect(heading).toContainText("5 dependency arrows");
  await expect(heading).toContainText("7 shared-resource conflicts");
  const legend = page.getByTestId("symphony-graph-legend");
  for (const state of [
    "Ready",
    "Waiting",
    "Running",
    "Blocked",
    "Finishing",
    "Completed",
  ]) {
    await expect(legend).toContainText(state);
  }
  // The filtered legend never lists states the displayed score is without.
  await expect(page.getByTestId("symphony-graph")).not.toContainText("Failed");
  const selection = page.getByTestId("symphony-graph-selection");
  await page.getByTestId("symphony-node-persist").click();
  await expect(page.getByTestId("symphony-graph-selection-title")).toHaveText(
    "Selected persist: Investigate persist",
  );
  await expect(selection).toContainText("Conflict with api");
  await expect(selection).toContainText("Conflict with readback");
  await expect(selection).toContainText(
    "their work is serialized without adding a prerequisite",
  );
  // Unrelated dependency edges fade with a selected conflict partner.
  expect(
    await edgeOpacity(page, "symphony-edge-collect-ship-dependency-0"),
  ).toBe("0.3");
  // While persist is selected, its own conflict edge keeps full strength.
  expect(await edgeOpacity(page, "symphony-edge-persist-ui-conflict-0")).toBe(
    "1",
  );
  // Selecting an unrelated task fades that conflict edge again.
  await page.getByTestId("symphony-node-api").click();
  expect(await edgeOpacity(page, "symphony-edge-persist-ui-conflict-0")).toBe(
    "0.3",
  );
  await page.getByTestId("symphony-node-persist").click();
  expect(await edgeOpacity(page, "symphony-edge-persist-ui-conflict-0")).toBe(
    "1",
  );
});

test("a short canvas hugs its content; a large score scrolls inside the graph", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGraph(page, "long-title");
  const single = await scrollCanvas(page, "symphony-node-migration");
  expect(single).not.toBeNull();
  // 264px node + 8px inner padding + frame: the visible frame hugs the node.
  expect(single?.clientWidth ?? 0).toBeLessThanOrEqual(280);
  expect(
    (single?.scrollWidth ?? 0) - (single?.clientWidth ?? 0),
  ).toBeLessThanOrEqual(2);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(1440);

  // The multi-task score is wider than the detail pane: it must scroll inside
  // the frame at both widths while the page never overflows.
  await openGraph(page, "multi");
  const wide = await scrollCanvas(page, "symphony-node-api");
  expect(wide?.scrollWidth ?? 0).toBeGreaterThan(wide?.clientWidth ?? 0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(1440);
  await page.setViewportSize({ width: 390, height: 844 });
  const compact = await scrollCanvas(page, "symphony-node-api");
  expect(compact?.scrollWidth ?? 0).toBeGreaterThan(compact?.clientWidth ?? 0);
  // Compact nodes stay at the compact width budget.
  const compactNode = await page
    .getByTestId("symphony-node-api")
    .evaluate((element) => element.getBoundingClientRect().width);
  expect(compactNode).toBeLessThanOrEqual(224);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("nodes show the worker's harness mark and model on the ID row", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGraph(page, "workers");
  // A resolved launch snapshot: the accessible name carries provider, model
  // and thinking level; the row shows the model label only.
  const claude = page.getByTestId("symphony-worker-claude");
  await expect(claude).toHaveText("Opus 5.5");
  // The Claude mark is a bundled image asset.
  await expect(claude.locator("img")).toHaveCount(1);
  // With a short ID the group sits opposite it at the row's trailing edge.
  const claudeWide = await workerTextMetrics(page, "claude");
  expect(claudeWide.trailingGap).toBeGreaterThanOrEqual(11);
  expect(claudeWide.trailingGap).toBeLessThanOrEqual(13);
  await expect(page.getByTestId("symphony-node-claude")).toHaveAttribute(
    "aria-label",
    /Runs on Claude, Opus 5\.5, Extended\.$/,
  );
  // An inline launch choice falls back to the launch fields.
  const codex = page.getByTestId("symphony-worker-codex");
  await expect(codex).toHaveText("Codex Max");
  await expect(codex.locator("img")).toHaveCount(1);
  await expect(page.getByTestId("symphony-node-codex")).toHaveAttribute(
    "aria-label",
    /Runs on Codex, Codex Max\.$/,
  );
  // A planned inline worker is drawn, not an image, and labelled as planned.
  const pi = page.getByTestId("symphony-worker-pi-plan");
  await expect(pi).toHaveText("Pi 5");
  await expect(pi.locator("img")).toHaveCount(0);
  await expect(page.getByTestId("symphony-node-pi-plan")).toHaveAttribute(
    "aria-label",
    /Planned: Pi, Pi 5, Standard\.$/,
  );
  // A profile-named planned worker resolves through the profiles list.
  await expect(page.getByTestId("symphony-node-planner-plan")).toHaveAttribute(
    "aria-label",
    /Planned: Claude, Opus 5\.5, Extended\.$/,
  );
  // A task whose worker resolves to nothing keeps the ID row as it was.
  await expect(page.getByTestId("symphony-worker-api")).toHaveCount(0);
  // The worker group shares the ID row without changing the node height.
  expect(await nodeHeight(page, "claude")).toBe(await nodeHeight(page, "api"));
  // The selection panel has room for the full identity including thinking.
  await page.getByTestId("symphony-node-claude").click();
  await expect(page.getByTestId("symphony-selection-worker-claude")).toHaveText(
    "Runs on Claude, Opus 5.5, Extended.",
  );
});

test("the worker group truncates on compact panes and never resizes the node", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGraph(page, "workers");
  const taskId = "migrate-cursor-pagination-export";
  // Wide: a short model label fits unclamped; the long one is capped at its
  // share of the ID row instead of resizing the node or the page.
  const claudeWide = await workerTextMetrics(page, "claude");
  expect(claudeWide.scrollWidth).toBeLessThanOrEqual(
    claudeWide.clientWidth + 1,
  );
  const wide = await workerTextMetrics(page, taskId);
  const wideNodeWidth = await page
    .getByTestId(`symphony-node-${taskId}`)
    .evaluate((element: HTMLElement) => element.getBoundingClientRect().width);
  expect(wide.groupWidth).toBeLessThanOrEqual(wideNodeWidth * 0.55 + 1);
  expect(wide.scrollWidth).toBeGreaterThanOrEqual(wide.clientWidth);
  // Even with the long ID the group still ends at the trailing edge; the ID
  // truncates first instead of pushing the group out of the node.
  expect(wide.trailingGap).toBeGreaterThanOrEqual(11);
  expect(wide.trailingGap).toBeLessThanOrEqual(13);
  // Compact: the long label clamps harder and the node height stays unchanged.
  await page.setViewportSize({ width: 390, height: 844 });
  const compact = await workerTextMetrics(page, taskId);
  expect(compact.scrollWidth).toBeGreaterThan(compact.clientWidth);
  expect(compact.trailingGap).toBeGreaterThanOrEqual(11);
  expect(compact.trailingGap).toBeLessThanOrEqual(13);
  expect(await nodeHeight(page, taskId)).toBe(await nodeHeight(page, "api"));
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("captures design evidence screenshots across themes and layouts", async ({
  page,
}) => {
  await mkdir(EVIDENCE, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  let detail = await openGraph(page, "multi");
  await page.getByTestId("symphony-node-persist").click();
  await expect(page.getByTestId("symphony-graph-selection-title")).toHaveText(
    "Selected persist: Investigate persist",
  );
  await page.screenshot({
    path: resolve(EVIDENCE, "wide-light-selection.png"),
  });
  // The selection panel itself, with the explicit Open agent action: the
  // default symphony's api task gains a live attempt through the preview's
  // claim control.
  await page.goto("/?symphonies");
  await page.getByRole("tab", { name: "Symphonies", exact: true }).click();
  await page
    .getByRole("button", { name: /^Open symphony:/ })
    .first()
    .click();
  await expect(page.getByTestId("symphony-detail")).toBeVisible();
  await page
    .getByRole("button", { name: "Source claims task", exact: true })
    .click();
  detail = page.getByTestId("symphony-detail");
  await detailButton(detail, "Graph").click();
  await expect(page.getByTestId("symphony-graph")).toBeVisible();
  await page.getByTestId("symphony-node-api").click();
  await expect(page.getByTestId("symphony-graph-selection")).toBeVisible();
  await page.getByTestId("symphony-graph-selection").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: resolve(EVIDENCE, "wide-light-open-agent.png"),
  });
  await page.goto("/?symphonies&symphony-fixture=multi&dark");
  await page.getByRole("tab", { name: "Symphonies", exact: true }).click();
  await page
    .getByRole("button", { name: /^Open symphony:/ })
    .first()
    .click();
  detail = page.getByTestId("symphony-detail");
  await expect(detail).toBeVisible();
  await detailButton(detail, "Graph").click();
  await expect(page.getByTestId("symphony-graph")).toBeVisible();
  await page.getByTestId("symphony-node-persist").click();
  await expect(page.getByTestId("symphony-graph-selection")).toBeVisible();
  await page.screenshot({
    path: resolve(EVIDENCE, "wide-dark-selection.png"),
  });
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/?symphonies&symphony-fixture=multi");
  await page.getByRole("tab", { name: "Symphonies", exact: true }).click();
  await page
    .getByRole("button", { name: /^Open symphony:/ })
    .first()
    .click();
  detail = page.getByTestId("symphony-detail");
  await detailButton(detail, "Graph").click();
  await expect(page.getByTestId("symphony-graph")).toBeVisible();
  await page.getByTestId("symphony-node-persist").click();
  await expect(page.getByTestId("symphony-graph-selection")).toBeVisible();
  await page.screenshot({
    path: resolve(EVIDENCE, "intermediate-light.png"),
  });
  // The worker fixture: harness marks and model labels on the node ID rows.
  await page.setViewportSize({ width: 1440, height: 900 });
  detail = await openGraph(page, "workers");
  await page.getByTestId("symphony-node-claude").click();
  await expect(page.getByTestId("symphony-graph-selection")).toBeVisible();
  await page.screenshot({
    path: resolve(EVIDENCE, "wide-light-workers.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: resolve(EVIDENCE, "compact-light.png"),
  });
  // The compact Open agent target measures at the 44px compact floor. The
  // default symphony's claim control gives api a live attempt again.
  await page.goto("/?symphonies");
  await page.getByRole("tab", { name: "Symphonies", exact: true }).click();
  await page
    .getByRole("button", { name: /^Open symphony:/ })
    .first()
    .click();
  await expect(page.getByTestId("symphony-detail")).toBeVisible();
  await page
    .getByRole("button", { name: "Source claims task", exact: true })
    .click();
  detail = page.getByTestId("symphony-detail");
  await detailButton(detail, "Graph").click();
  await expect(page.getByTestId("symphony-graph")).toBeVisible();
  await page.getByTestId("symphony-node-api").click();
  await expect(page.getByTestId("symphony-graph-selection")).toBeVisible();
  const openAgentHeight = await page
    .getByTestId("symphony-graph-open-agent")
    .evaluate((element) => element.getBoundingClientRect().height);
  expect(openAgentHeight).toBeGreaterThanOrEqual(44);
});
