import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Layout probe: measures geometry at the required viewports/themes (1440x900,
 * 390x844, 768px, and 150% zoom) in both the Tasks and Graph views, and
 * records the numbers as JSON evidence. The card-title and node-title text
 * metrics distinguish wrapping (full text visible on cards) from intentional
 * node truncation, and the graph-canvas metrics prove the canvas scrolls
 * internally while the page never overflows.
 */

const EVIDENCE = fileURLToPath(
  new URL(
    "../../../.artifacts/reviews/20261006-conductor-symphony-ui",
    import.meta.url,
  ),
);

type Probe = {
  viewport: string;
  theme: string;
  view: "tasks" | "graph";
  pageOverflow: boolean;
  pageScrollWidth: number;
  pageClientWidth: number;
  graphCanvas: { found: boolean; scrollWidth: number; clientWidth: number };
  cardTitle: { clientHeight: number; scrollHeight: number } | null;
  nodeTitle: { clientHeight: number; scrollHeight: number } | null;
  tabStrip: { scrollable: boolean; tabs: number };
  conductorActionVisible: boolean;
};

async function openMulti(page: Page, theme: string) {
  await page.goto(`/?symphonies&symphony-fixture=multi${theme}`);
  await page.getByRole("tab", { name: "Symphonies", exact: true }).click();
  await page
    .getByRole("button", { name: /^Open symphony:/ })
    .first()
    .click();
  await expect(page.getByTestId("symphony-detail")).toBeVisible();
}

async function probeLayout(
  page: Page,
  viewport: string,
  theme: string,
  view: "tasks" | "graph",
): Promise<Probe> {
  const detail = page.getByTestId("symphony-detail");
  if (view === "graph") {
    await detail.getByRole("button", { name: "Graph", exact: true }).click();
    await expect(page.getByTestId("symphony-graph")).toBeVisible();
  }
  const overflow = await page.evaluate(() => ({
    pageOverflow: document.documentElement.scrollWidth > innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  const canvas =
    view === "graph"
      ? await page
          .getByTestId("symphony-node-api")
          .evaluate((element: HTMLElement) => {
            let node: HTMLElement | null = element.parentElement;
            while (node && node.scrollWidth <= node.clientWidth) {
              node = node.parentElement;
            }
            if (!node || node === document.documentElement) {
              return null;
            }
            return {
              scrollWidth: node.scrollWidth,
              clientWidth: node.clientWidth,
            };
          })
      : null;
  // The longest text node inside the card/node is the title; its scroll
  // height vs client height tells whether wrapping shows all lines or the
  // two-line clamp truncates the node title intentionally.
  const nodeTitle: Probe["nodeTitle"] =
    view === "graph"
      ? ((await page
          .getByTestId("symphony-node-api")
          .evaluate((element: HTMLElement) => {
            let best: {
              clientHeight: number;
              scrollHeight: number;
              text: string;
            } | null = null;
            for (const child of Array.from(element.querySelectorAll("div"))) {
              const text = (child.textContent ?? "").trim();
              if (!text) {
                continue;
              }
              if (!best || text.length > best.text.length) {
                best = {
                  clientHeight: child.clientHeight,
                  scrollHeight: child.scrollHeight,
                  text,
                };
              }
            }
            return best
              ? {
                  clientHeight: best.clientHeight,
                  scrollHeight: best.scrollHeight,
                }
              : null;
          })) as Probe["nodeTitle"])
      : null;
  const cardTitle: Probe["cardTitle"] =
    view === "tasks"
      ? ((await page
          .getByTestId("symphony-task-api")
          .evaluate((element: HTMLElement) => {
            let best: {
              clientHeight: number;
              scrollHeight: number;
              text: string;
            } | null = null;
            for (const child of Array.from(element.querySelectorAll("div"))) {
              const text = (child.textContent ?? "").trim();
              if (!text) {
                continue;
              }
              if (!best || text.length > best.text.length) {
                best = {
                  clientHeight: child.clientHeight,
                  scrollHeight: child.scrollHeight,
                  text,
                };
              }
            }
            return best
              ? {
                  clientHeight: best.clientHeight,
                  scrollHeight: best.scrollHeight,
                }
              : null;
          })) as Probe["cardTitle"])
      : null;
  const tabStrip = await detail
    .getByRole("button", { name: "Tasks", exact: true })
    .evaluate((element: HTMLElement) => {
      const strip = element.parentElement;
      return {
        scrollable: Boolean(strip && strip.scrollWidth > strip.clientWidth + 4),
        tabs: strip
          ? strip.querySelectorAll("button, [aria-pressed], [role=tab]").length
          : 0,
      };
    });
  return {
    viewport,
    theme,
    view,
    pageOverflow: overflow.pageOverflow,
    pageScrollWidth: overflow.scrollWidth,
    pageClientWidth: overflow.clientWidth,
    graphCanvas: {
      found: canvas !== null,
      scrollWidth: canvas?.scrollWidth ?? 0,
      clientWidth: canvas?.clientWidth ?? 0,
    },
    cardTitle: cardTitle ?? null,
    nodeTitle: nodeTitle ?? null,
    tabStrip,
    conductorActionVisible: await detail
      .getByRole("button", { name: "Conductor agent", exact: true })
      .isVisible()
      .catch(() => false),
  };
}

test("layout probe collects geometry at the required viewports and themes", async ({
  page,
}) => {
  await mkdir(EVIDENCE, { recursive: true });
  const probes: Probe[] = [];

  const collect = async (
    viewport: string,
    theme: string,
    themeSuffix: string,
  ) => {
    await openMulti(page, themeSuffix);
    probes.push(await probeLayout(page, viewport, theme, "tasks"));
    probes.push(await probeLayout(page, viewport, theme, "graph"));
  };

  await page.setViewportSize({ width: 1440, height: 900 });
  await collect("1440x900", "light", "");
  await collect("1440x900", "dark", "&dark");

  await page.setViewportSize({ width: 390, height: 844 });
  await collect("390x844", "light", "&global");
  await collect("390x844", "dark", "&global&dark");

  await page.setViewportSize({ width: 768, height: 1024 });
  await collect("768x1024", "light", "");

  // 150% browser zoom at wide.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1.5 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await collect("1440x900-zoom150", "light", "");
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });

  await writeFile(
    resolve(EVIDENCE, "layout-probe.json"),
    JSON.stringify(probes, null, 2),
  );

  for (const probe of probes) {
    expect(
      probe.pageOverflow,
      `${probe.viewport}/${probe.theme}/${probe.view} must not overflow the page`,
    ).toBe(false);
    if (probe.view === "graph") {
      // The multi-symphony graph is wider than every probed detail pane, so the
      // canvas must scroll internally instead of the page.
      expect(
        probe.graphCanvas.found,
        `${probe.viewport}/${probe.theme} graph must scroll internally`,
      ).toBe(true);
    } else {
      // Card titles wrap fully: client height covers every rendered line.
      expect(
        probe.cardTitle?.scrollHeight ?? 0,
        `${probe.viewport}/${probe.theme} card title`,
      ).toBeLessThanOrEqual((probe.cardTitle?.clientHeight ?? 0) + 1);
    }
    // Tasks, Graph, Context, and History; Export was intentionally removed.
    expect(
      probe.tabStrip.tabs,
      `${probe.viewport}/${probe.theme}/${probe.view} tab strip`,
    ).toBe(4);
    expect(
      probe.conductorActionVisible,
      `${probe.viewport}/${probe.theme}/${probe.view} Conductor agent action`,
    ).toBe(true);
  }

  // The single-node long-title symphony must fit without a huge empty stage.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?symphonies&symphony-fixture=long-title");
  await page.getByRole("tab", { name: "Symphonies", exact: true }).click();
  await page
    .getByRole("button", { name: /^Open symphony:/ })
    .first()
    .click();
  const detail = page.getByTestId("symphony-detail");
  await detail.getByRole("button", { name: "Graph", exact: true }).click();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(1440);
  const singleCanvas = await page
    .getByTestId("symphony-node-migration")
    .evaluate((element: HTMLElement) => {
      let node: HTMLElement | null = element.parentElement;
      while (node && node.scrollWidth <= node.clientWidth) {
        node = node.parentElement;
      }
      if (!node || node === document.documentElement) {
        return null;
      }
      return { scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
    });
  // 264px node + margins must fit the wide detail without scrolling.
  expect(singleCanvas?.scrollWidth ?? 0).toBeLessThanOrEqual(320);
});
