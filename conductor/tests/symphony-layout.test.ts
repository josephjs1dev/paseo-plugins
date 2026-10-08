import assert from "node:assert/strict";
import test from "node:test";
import { conflictReason } from "../shared/symphonies/score";
import { graphGeometry, layoutGraph } from "../shared/symphonies/layout";
import type { TaskDefinition } from "../shared/symphonies/models";
import { score, task } from "./symphony-fixtures";

/** Sixteen-word title that must truncate inside the graph node. */
function longTask(): TaskDefinition {
  return task("probe", {
    title:
      "Investigate every pagination compatibility surface before the wrap decision",
  });
}

void test("geometry matches the documented node budget in both modes", () => {
  const wide = layoutGraph(score(), false);
  const compact = layoutGraph(score(), true);
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

void test("a single-node symphony stays small; content height leaves no empty stage", () => {
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
      task("w2", { ...shared, prerequisites: [] }),
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

void test("only the transitive reduction of prerequisites is drawn", () => {
  const layout = layoutGraph(
    {
      tasks: [
        task("t1"),
        task("t2", { prerequisites: ["t1"] }),
        task("t3", { prerequisites: ["t1", "t2"] }),
        task("t4", { prerequisites: ["t1", "t2", "t3"] }),
      ],
    },
    false,
  );
  assert.deepEqual(
    layout.edges.map((edge) => `${edge.from}->${edge.to}`),
    ["t1->t2", "t2->t3", "t3->t4"],
  );
  assert.deepEqual(
    layout.nodes.map((node) => node.layer),
    [0, 1, 2, 3],
  );
});

void test("conflicts between prerequisite-ordered tasks are not drawn", () => {
  const shared = {
    reads: [],
    writes: ["src/api"],
    worker: { role: "implementation" as const, profile: "default" },
  };
  const layout = layoutGraph(
    {
      tasks: [
        task("a", { ...shared }),
        task("b", { ...shared, prerequisites: ["a"] }),
        task("c", { ...shared, prerequisites: ["b"] }),
        task("d", { ...shared }),
      ],
    },
    false,
  );
  assert.deepEqual(
    layout.edges
      .filter((edge) => edge.kind === "conflict")
      .map((edge) => [edge.from, edge.to].sort().join("~"))
      .sort(),
    ["a~d", "b~d", "c~d"],
  );
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
    layoutGraph(score(), false).nodes.every(
      (node) => node.height >= 96 && node.width >= 220,
    ),
  );
});
