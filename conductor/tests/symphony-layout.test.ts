import assert from "node:assert/strict";
import test from "node:test";
import { conflictReason } from "../shared/symphonies/score";
import { graphGeometry, layoutGraph } from "../shared/symphonies/layout";
import type { TaskDefinition } from "../shared/symphonies/models";
import {
  groupedTaskState,
  hasLoopGroups,
  historyLoops,
  loopRecord,
  scoreAtLoop,
  symphonyAtLoop,
  unresolvedItemLabel,
} from "../client/symphonies/history";
import { latestAttempt } from "../shared/symphonies/models";
import {
  fixtureAttempt,
  fixtureLaunch,
  score,
  storedSymphony,
  task,
} from "./symphony-fixtures";

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

void test("the summary counts tasks, reduced dependencies, and conflicts", () => {
  const chain = layoutGraph(
    {
      tasks: [
        task("t1"),
        task("t2", { prerequisites: ["t1"] }),
        task("t3", { prerequisites: ["t1", "t2"] }),
      ],
    },
    false,
  );
  // The transitive edge t1->t3 is reduced, so only two arrows remain.
  assert.deepEqual(chain.summary, { tasks: 3, dependencies: 2, conflicts: 0 });
  const multi = layoutGraph(score(), false);
  assert.deepEqual(multi.summary, { tasks: 3, dependencies: 2, conflicts: 0 });
});

void test("shared-resource conflicts count in the summary heading", () => {
  const shared = {
    reads: [],
    writes: ["src/api"],
    worker: { role: "implementation" as const, profile: "default" },
  };
  const layout = layoutGraph(
    {
      tasks: [
        task("w1", shared),
        task("w2", { ...shared }),
        task("w3", { ...shared }),
      ],
    },
    false,
  );
  assert.equal(layout.summary.conflicts, 3);
  assert.equal(layout.summary.dependencies, 0);
  assert.equal(layout.summary.tasks, 3);
});

void test("a single-node summary describes an empty score", () => {
  const single = layoutGraph({ tasks: [task("only")] }, true);
  assert.deepEqual(single.summary, { tasks: 1, dependencies: 0, conflicts: 0 });
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

// === Loop-grouped History ===

/**
 * A two-loop symphony: loop 1's review reported blocking findings, loop 2
 * reopened the owners and the review succeeded.
 */
function twoLoopSymphony() {
  const symphony = storedSymphony();
  const attempts = [
    fixtureAttempt("api", "completed", "b410f767-1197-469b-8b89-af35338a4ea1"),
    fixtureAttempt("ui", "completed", "b410f767-1197-469b-8b89-af35338a4ea2"),
    fixtureAttempt(
      "review",
      "needs-changes",
      "b410f767-1197-469b-8b89-af35338a4ea3",
      {
        report: {
          outcome: "needs-changes",
          summary: "Fix the api offset handling.",
          evidence: ["read the diff"],
          checks: [],
          findings: [
            {
              id: "F1",
              severity: "blocking",
              taskId: "api",
              paths: ["server/rpc.ts:41"],
              summary: "The offset branch rethrows instead of returning 400.",
            },
            {
              id: "F2",
              severity: "minor",
              taskId: "ui",
              paths: ["client/pagination.tsx:12"],
              summary: "Label is truncated one character early.",
            },
          ],
        },
        reportHash: "c".repeat(64),
        launch: fixtureLaunch(true),
      },
    ),
    {
      ...fixtureAttempt(
        "api",
        "completed",
        "b410f767-1197-469b-8b89-af35338a4ea4",
        { launch: fixtureLaunch(true) },
      ),
      loop: 2,
      reopen: {
        reason: "Fix review finding F1 — stop rethrowing in the offset branch.",
        findings: [],
      },
      report: {
        outcome: "completed" as const,
        summary: "Offset branch returns 400 now.",
        evidence: ["contract test green"],
        checks: [{ name: "contract", status: "passed" as const, detail: "ok" }],
      },
      reportHash: "c".repeat(64),
    },
    {
      ...fixtureAttempt(
        "review",
        "completed",
        "b410f767-1197-469b-8b89-af35338a4ea5",
        { launch: fixtureLaunch(true), recheck: true },
      ),
      loop: 2,
      reopen: {
        reason: "Confirm F1 is fixed.",
        findings: [],
      },
      report: {
        outcome: "completed" as const,
        summary: "No blocking finding remains.",
        evidence: ["re-read the diff"],
        checks: [],
      },
      reportHash: "c".repeat(64),
    },
  ];
  return {
    ...symphony,
    execution: {
      ...symphony.execution,
      attempts: [...symphony.execution.attempts, ...attempts],
      conducting: {
        phase: "working" as const,
        concurrency: 2,
        requestedBy: null,
        conductor: "agent" as const,
        conductorLaunch: "started" as const,
        prompt: "Coordinate",
        notification: "loop-end:2",
        loops: [
          {
            number: 2,
            reason: "Fix review findings F1-F2",
            startedAt: attempts[3] ? 0 : 0,
            reopened: [{ taskId: "api", findings: ["F1"] }],
            added: [],
            deferred: [
              { finding: "review#F1", reason: "Needs a product decision." },
            ],
          },
        ],
      },
    },
    revisions: [
      {
        number: 1,
        parent: null,
        reason: "Breakdown",
        acceptedAt: 0,
        score: {
          tasks: [
            task("api"),
            task("ui"),
            task("review", { prerequisites: ["api", "ui"] }),
          ],
        },
      },
    ],
  };
}

void test("a single-loop symphony keeps its ungrouped history", () => {
  const symphony = storedSymphony();
  assert.equal(hasLoopGroups(symphony), false);
  assert.deepEqual(historyLoops(symphony), []);
});

void test("records stored before loops count as loop 1", () => {
  const symphony = twoLoopSymphony();
  const conducting = symphony.execution.conducting;
  if (!conducting) {
    throw new Error("fixture must carry conducting metadata");
  }
  // Old records never carried loop records or a per-loop wake identity.
  const legacyConducting = {
    phase: conducting.phase,
    concurrency: conducting.concurrency,
    requestedBy: conducting.requestedBy,
    conductor: conducting.conductor,
    conductorLaunch: conducting.conductorLaunch,
    prompt: conducting.prompt,
    notification: "all-reported",
  } as const;
  const withoutLoopMarkers = {
    ...symphony,
    execution: {
      ...symphony.execution,
      conducting: {
        ...legacyConducting,
        // Old records kept the constant wake identity and no loop records.
        notification: "all-reported" as const,
      },
      // Only the pre-loop attempts exist, and none of them carries loop,
      // reopen, or recheck markers.
      attempts: symphony.execution.attempts
        .filter((attempt) => attempt.loop === undefined || attempt.loop === 1)
        // The stripped markers are exactly the backwards-compat feature under
        // test, so their unused destructuring is intentional here.
        .map(
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          ({ loop, reopen, recheck, ...attempt }) => attempt,
        ),
    },
  };
  assert.equal(hasLoopGroups(withoutLoopMarkers), false);
  const [only] = historyLoops(withoutLoopMarkers);
  assert.equal(only?.verdict, "needs-changes");
  assert.equal(only?.blocking, 1);
});

void test("loop groups carry verdict, blocking count, and the loop record", () => {
  const groups = historyLoops(twoLoopSymphony());
  assert.equal(groups.length, 2);
  const first = groups[0];
  assert.equal(first?.loop, 1);
  assert.equal(first?.verdict, "needs-changes");
  assert.equal(first?.blocking, 1);
  assert.equal(first?.reason, undefined);
  assert.equal(first?.running, false);
  const second = groups[1];
  assert.equal(second?.loop, 2);
  assert.equal(second?.verdict, "succeeded");
  assert.equal(second?.blocking, 0);
  assert.equal(second?.reason, "Fix review findings F1-F2");
  assert.deepEqual(second?.deferred, [
    { label: "review#F1", reason: "Needs a product decision." },
  ]);
  assert.equal(second?.attempts.length, 2);
});

void test("an unfinished loop reads as attention, not a verdict", () => {
  const symphony = twoLoopSymphony();
  const running = {
    ...fixtureAttempt("ui", "running", "b410f767-1197-469b-8b89-af35338a4ea6", {
      launch: fixtureLaunch(false),
    }),
    loop: 3,
  };
  const groups = historyLoops({
    ...symphony,
    execution: {
      ...symphony.execution,
      attempts: [...symphony.execution.attempts, running],
    },
  });
  const third = groups.at(-1);
  assert.equal(third?.verdict, "attention");
  assert.equal(third?.running, true);
});

void test("the current loop group agrees with the server verdict", () => {
  const symphony = twoLoopSymphony();
  // A failed task in the current loop needs attention, not "needs changes".
  const failedApi = symphony.execution.attempts.map((attempt) =>
    attempt.taskId === "api" && attempt.loop === 2
      ? {
          ...attempt,
          state: "failed" as const,
          report: {
            outcome: "failed" as const,
            summary: "The agent could not run its checks.",
            evidence: ["sandbox denied the test runner"],
            checks: [],
          },
        }
      : attempt,
  );
  const failed = historyLoops({
    ...symphony,
    execution: { ...symphony.execution, attempts: failedApi },
  }).at(-1);
  assert.equal(failed?.verdict, "attention");
  assert.equal(failed?.running, false);
  // A loop whose reopened owner has not started yet is still in progress,
  // never "succeeded" because nothing ran in it so far.
  const pending = historyLoops({
    ...symphony,
    execution: {
      ...symphony.execution,
      attempts: symphony.execution.attempts.filter(
        (attempt) => attempt.loop !== 2,
      ),
    },
  }).at(-1);
  assert.equal(pending?.loop, 2);
  assert.equal(pending?.running, true);
  assert.notEqual(pending?.verdict, "succeeded");
});

void test("a loop group states its own last attempt, not the task's newer state", () => {
  const groups = historyLoops(twoLoopSymphony());
  const firstReview = groups[0]?.attempts.find(
    (attempt) => attempt.taskId === "review",
  );
  assert.ok(firstReview);
  assert.equal(groupedTaskState(firstReview), "needs-changes");
  const lastApi = groups.at(-1)?.attempts.at(-1);
  assert.ok(lastApi);
  assert.equal(groupedTaskState(lastApi), "completed");
});

void test("unresolved items label the finding or the owning task", () => {
  assert.equal(
    unresolvedItemLabel({ finding: "api#F1", reason: "User stopped." }),
    "api#F1 — User stopped.",
  );
  assert.equal(
    unresolvedItemLabel({ taskId: "ui", reason: "User stopped." }),
    "ui — User stopped.",
  );
});

void test("a past loop shows the symphony as that loop ended", () => {
  const symphony = twoLoopSymphony();
  // The latest loop is the stored symphony itself.
  assert.equal(symphonyAtLoop(symphony, 2), symphony);
  const loop1 = symphonyAtLoop(symphony, 1);
  assert.equal(latestAttempt(loop1, "review")?.state, "needs-changes");
  assert.equal(latestAttempt(loop1, "api")?.report?.summary, undefined);
  assert.deepEqual(loop1.execution.conducting?.loops, []);
  assert.equal(loopRecord(loop1, 2), undefined);
  // A task that did not re-run in loop 2 keeps its loop 1 result there.
  assert.equal(latestAttempt(symphony, "ui")?.loop, undefined);
  assert.equal(loopRecord(symphony, 2)?.reason, "Fix review findings F1-F2");
});

void test("a past loop leaves out tasks a later loop appended", () => {
  const base = twoLoopSymphony();
  const conducting = base.execution.conducting;
  assert.ok(conducting);
  const revision = base.revisions[0];
  assert.ok(revision);
  const symphony = {
    ...base,
    execution: {
      ...base.execution,
      conducting: {
        ...conducting,
        loops: (conducting.loops ?? []).map((record) => ({
          ...record,
          added: ["plan-2"],
        })),
      },
    },
    revisions: [
      ...base.revisions,
      {
        ...revision,
        number: 2,
        parent: 1,
        score: { tasks: [...revision.score.tasks, task("plan-2")] },
      },
    ],
  };
  const ids = (loop: number) =>
    scoreAtLoop(symphony, loop).tasks.map((entry) => entry.id);
  assert.deepEqual(ids(1), ["api", "ui", "review"]);
  assert.deepEqual(ids(2), ["api", "ui", "review", "plan-2"]);
});
