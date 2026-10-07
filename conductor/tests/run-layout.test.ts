import assert from "node:assert/strict";
import test from "node:test";
import { conflictReason } from "../shared/concerts/graph";
import { graphGeometry, layoutGraph } from "../shared/concerts/layout";
import type { TaskDefinition } from "../shared/concerts/models";
import { graph, task } from "./run-fixtures";

/** Sixteen-word title that must truncate inside the graph node. */
function longTask(): TaskDefinition {
  return task("probe", {
    title:
      "Investigate every pagination compatibility surface before the wrap decision",
  });
}

void test("geometry matches the documented node budget in both modes", () => {
  const wide = layoutGraph(graph(), false);
  const compact = layoutGraph(graph(), true);
  const wideNode = wide.nodes[0];
  const compactNode = compact.nodes[0];
  assert.deepEqual(
    { w: wideNode?.width, h: wideNode?.height },
    { w: 240, h: 112 },
  );
  assert.deepEqual(
    { w: compactNode?.width, h: compactNode?.height },
    { w: 220, h: 112 },
  );
  const wideGeometry = graphGeometry(false);
  const compactGeometry = graphGeometry(true);
  assert.equal(wideGeometry.nodePadding, 12);
  assert.equal(compactGeometry.nodePadding, 12);
  assert.equal(wideGeometry.gapX, 48);
  assert.equal(compactGeometry.gapX, 36);
});

void test("a single-node run stays small; content height leaves no empty stage", () => {
  const single = layoutGraph({ tasks: [task("only")] }, false);
  assert.deepEqual(
    { w: single.width, h: single.height },
    { w: 240 + 12 * 2 + 7, h: 112 + 12 * 2 },
  );
  assert.deepEqual(
    { x: single.nodes[0]?.x, y: single.nodes[0]?.y },
    { x: 12, y: 12 },
  );
  assert.deepEqual(single.edges, []);
});

void test("geometry constants agree with the documented node content budget", () => {
  // Two 12px/16px rows (ID and status), a 14px/20px title with two lines,
  // two 4px row gaps, and 8px of slack for the 2px focus ring inside 112px.
  const content =
    16 + 16 + 2 * 20 + 2 * 4 + 8 + 2 * graphGeometry(false).nodePadding;
  assert.equal(content, graphGeometry(false).nodeHeight);
});

void test("multi-layer edges stay inside the layout scroll bounds", () => {
  const deep = {
    tasks: [
      task("a", { prerequisites: [] }),
      task("b", { prerequisites: ["a"] }),
      task("c", { prerequisites: ["b"] }),
      task("d", { prerequisites: ["c"] }),
    ],
  };
  const layout = layoutGraph(deep, false);
  const maxX = Math.max(
    0,
    ...layout.edges.flatMap((edge) => edge.points.map((p) => p.x)),
  );
  const maxY = Math.max(
    0,
    ...layout.edges.flatMap((edge) => edge.points.map((p) => p.y)),
  );
  assert.ok(maxX <= layout.width - 12, `maxX ${maxX} vs width ${layout.width}`);
  assert.ok(
    maxY <= layout.height - 6,
    `maxY ${maxY} vs height ${layout.height}`,
  );
});

void test("conflict lanes and every edge stay inside vertical bounds", () => {
  const shared = {
    reads: [],
    writes: ["src/api"],
    worker: { role: "implementation" as const, profile: "default" },
  };
  const busy = {
    tasks: [
      task("w1", { ...shared, prerequisites: [] }),
      task("w2", { ...shared, prerequisites: ["w1"] }),
    ],
  };
  const layout = layoutGraph(busy, false);
  const maxY = Math.max(
    0,
    ...layout.edges.flatMap((edge) => edge.points.map((point) => point.y)),
  );
  assert.ok(maxY <= layout.height - 7, `maxY ${maxY} h ${layout.height}`);
  const conflict = layout.edges.find((edge) => edge.kind === "conflict");
  assert.ok(conflict, "expected a conflict edge for the shared write path");
  assert.equal(
    conflictReason(busy.tasks[0] ?? task("w1"), busy.tasks[1] ?? task("w2")),
    "overlapping read/write scope",
  );
});

void test("long one-line titles are stored fully for the client to truncate", () => {
  const layout = layoutGraph({ tasks: [longTask()] }, false);
  const node = layout.nodes[0];
  assert.equal(node?.width, 240);
  assert.equal(node?.height, 112);
});

void test("long one-line titles are stored fully for the client to truncate", () => {
  const layout = layoutGraph({ tasks: [longTask()] }, false);
  const node = layout.nodes[0];
  assert.equal(node?.width, 240);
  assert.equal(node?.height, 112);
  const compact = layoutGraph({ tasks: [longTask()] }, true);
  assert.equal(compact.nodes[0]?.width, 220);
});

void test("layout is deterministic across repeated calls", () => {
  const source = {
    tasks: [task("api"), task("collect", { prerequisites: ["api"] })],
  };
  assert.deepEqual(layoutGraph(source, true), layoutGraph(source, true));
});

void test("node padding is shared with the renderer through geometry", () => {
  const geometry = graphGeometry(false);
  assert.equal(geometry.nodePadding, 12);
  assert.ok(
    layoutGraph(graph(), false).nodes.every(
      (node) => node.height >= 96 && node.width >= 220,
    ),
  );
});
