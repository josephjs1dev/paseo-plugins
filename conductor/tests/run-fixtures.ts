import type {
  RunAttempt,
  RunContext,
  RunGraph,
  RunPlacement,
  StoredRun,
  TaskDefinition,
} from "../shared/run-models";

export const runId = "f1151538-5302-4fbf-b50b-f6a55f2a5940";
export const planContext: RunContext = {
  plan: "Investigate API and UI pagination, then collect the findings.",
  provenance: "Selected source-agent plan",
  decisions: ["Keep cursor pagination"],
  constraints: ["Read only"],
  expectedOutcome: "Reports with evidence and remaining uncertainties",
};
export const placement: RunPlacement = {
  workspaceId: "ws-api",
  agentId: "agent-1",
  workspaceName: "Conductor workspace",
  checkout: "/test/repo",
  branch: "feature/pagination",
  base: "1234",
  dirtyFingerprint: null,
};
export function task(
  id: string,
  patch: Partial<TaskDefinition> = {},
): TaskDefinition {
  return {
    id,
    title: `Investigate ${id}`,
    outcome: `Report findings for ${id}`,
    prerequisites: [],
    inputs: ["Selected plan"],
    reads: ["src"],
    writes: [],
    resources: [],
    worker: { role: "exploration", profile: "default" },
    criteria: ["Findings include evidence and uncertainty"],
    checks: [],
    stopWhen: "Return the report",
    ...patch,
  };
}
export function graph(): RunGraph {
  return {
    tasks: [
      task("api"),
      task("ui"),
      task("collect", { prerequisites: ["api", "ui"] }),
    ],
  };
}
export function storedRun(): StoredRun {
  return {
    schemaVersion: 1,
    id: runId,
    version: 0,
    title: "Pagination investigation",
    source: placement,
    contextHash: "a".repeat(64),
    requestHash: "b".repeat(64),
    createdAt: 1791201600000,
    updatedAt: 1791201600000,
    status: "draft",
    execution: null,
    draft: graph(),
    revisions: [],
  };
}

// === Integration scenario fixtures (additive; base fixtures above are unchanged) ===
// Each returns a schema-valid, post-acceptance StoredRun exercising one visible
// state for the preview and browser verification. IDs are fixed so screenshots
// and assertions stay reproducible.

export const longTaskTitle =
  "Migrate the legacy offset-pagination export surface to cursor pagination without dropping any in-flight request mid-cycle";

export function fixtureAttempt(
  taskId: string,
  state: RunAttempt["state"],
  id: string,
  patch: Partial<RunAttempt> = {},
): RunAttempt {
  const started = 1791201600000;
  return {
    id,
    taskId,
    agentId: `worker-${taskId}`,
    state,
    startedAt: started,
    endedAt: state === "running" ? null : started + 1000 * 60 * 5,
    message: null,
    report: null,
    reportHash: null,
    ...patch,
  };
}

export function fixtureLaunch(
  settled: boolean,
  state: "started" | "uncertain" = "started",
): NonNullable<RunAttempt["launch"]> {
  return { state, prompt: "Carry out the task and report evidence", settled };
}

/** A long multi-line run summary that must trigger the Show more control. */
export const longSummary = [
  "Reviewed the export endpoint and the UI fixtures.",
  "Cursor pagination passes; offset pagination stays flagged.",
  "The regression suite still fails on the offset export test.",
  "Recommend finishing the migration before the next release window.",
  "The full evidence trail is recorded in the run history.",
].join("\n");

function fixtureRun(
  tasks: TaskDefinition[],
  options: {
    id: string;
    title?: string;
    status?: StoredRun["status"];
    origin?: NonNullable<StoredRun["execution"]>["origin"];
    attempts?: RunAttempt[];
    summary?: string | null;
    finishedAt?: number | null;
    orchestration?: NonNullable<
      NonNullable<StoredRun["execution"]>["orchestration"]
    >;
  },
): StoredRun {
  const base = storedRun();
  return {
    ...base,
    id: options.id,
    title: options.title ?? base.title,
    status: options.status ?? "ready",
    execution: {
      origin: options.origin ?? "orchestrator",
      ...(options.orchestration
        ? { orchestration: options.orchestration }
        : {}),
      attempts: options.attempts ?? [],
      summary: options.summary ?? null,
      finishedAt: options.finishedAt ?? null,
      interruption: null,
    },
    draft: null,
    revisions: [
      {
        number: 1,
        parent: null,
        reason: "Source agent recorded the accepted task breakdown",
        acceptedAt: base.createdAt,
        authority: "agent",
        graph: { tasks },
      },
    ],
  };
}

/** The user's one-task long-title case: a single task with a wrapping title. */
export function longTitleRun(): StoredRun {
  return fixtureRun([task("migration", { title: longTaskTitle })], {
    id: "f1151538-5302-4fbf-b50b-f6a55f2a5a41",
    title: "Cursor pagination migration",
    status: "running",
    attempts: [
      fixtureAttempt(
        "migration",
        "running",
        "b410f767-1197-469b-8b89-af35338a4e01",
        { launch: fixtureLaunch(true) },
      ),
    ],
  });
}

/**
 * A multi-task graph: running, waiting, blocked, completed (with one failed
 * check), finishing, ready and a same-layer resource conflict pair.
 */
export function multiTaskRun(): StoredRun {
  return fixtureRun(
    [
      task("api"),
      task("probe"),
      task("persist", {
        reads: [],
        writes: ["src/api"],
        worker: { role: "implementation", profile: "default" },
      }),
      task("readback", { reads: ["src"], writes: [] }),
      task("ui", { prerequisites: ["api"] }),
      task("backend", { prerequisites: ["api"] }),
      task("collect", { prerequisites: ["ui", "backend"] }),
      task("ship", { prerequisites: ["collect"] }),
    ],
    {
      id: "f1151538-5302-4fbf-b50b-f6a55f2a5a42",
      title: "Pagination migration",
      status: "running",
      attempts: [
        fixtureAttempt(
          "api",
          "running",
          "b410f767-1197-469b-8b89-af35338a4e02",
          { launch: fixtureLaunch(true) },
        ),
        fixtureAttempt(
          "backend",
          "blocked",
          "b410f767-1197-469b-8b89-af35338a4e03",
          {
            message:
              "Confirm the pagination compatibility requirement in the source conversation.",
          },
        ),
        fixtureAttempt(
          "collect",
          "completed",
          "b410f767-1197-469b-8b89-af35338a4e04",
          {
            report: {
              outcome: "completed",
              summary: "Collected both findings and recorded the uncertainty.",
              evidence: [
                "Reviewed the API cursor implementation and the UI fixtures.",
                "Recorded the remaining pagination uncertainty for the source.",
              ],
              checks: [
                {
                  name: "API cursor coverage",
                  status: "passed",
                  detail: "All cursor cases pass.",
                },
                {
                  name: "UI fixtures",
                  status: "passed",
                  detail: "Fixtures render known states.",
                },
                {
                  name: "Regression suite",
                  status: "failed",
                  detail: "Offset export test still red.",
                },
              ],
            },
            reportHash: "c".repeat(64),
            launch: fixtureLaunch(true),
          },
        ),
        fixtureAttempt(
          "ship",
          "completed",
          "b410f767-1197-469b-8b89-af35338a4e05",
          {
            report: {
              outcome: "completed",
              summary: "Prepared the migration checklist.",
              evidence: ["Checklist includes rollback steps"],
              checks: [
                {
                  name: "Checklist review",
                  status: "passed",
                  detail: "Rollback steps present.",
                },
              ],
            },
            reportHash: "c".repeat(64),
            // Report delivered but the agent launch is still settling -> Finishing.
            launch: fixtureLaunch(false),
          },
        ),
      ],
    },
  );
}

/** Run with one explicitly blocked task and an actionable message. */
export function blockedRun(): StoredRun {
  return fixtureRun([task("export")], {
    id: "f1151538-5302-4fbf-b50b-f6a55f2a5a43",
    title: "Export blocker",
    status: "blocked",
    attempts: [
      fixtureAttempt(
        "export",
        "blocked",
        "b410f767-1197-469b-8b89-af35338a4e06",
        {
          message:
            "Confirm the pagination compatibility requirement in the source conversation.",
        },
      ),
    ],
  });
}

/** Completed run whose report carries a failed check and a long summary. */
export function failedChecksRun(): StoredRun {
  return fixtureRun([task("review")], {
    id: "f1151538-5302-4fbf-b50b-f6a55f2a5a44",
    title: "Check failures",
    status: "completed",
    summary: longSummary,
    finishedAt: 1791201600000 + 1000 * 60 * 30,
    attempts: [
      fixtureAttempt(
        "review",
        "completed",
        "b410f767-1197-469b-8b89-af35338a4e07",
        {
          report: {
            outcome: "completed",
            summary: "Reviewed and recorded the findings.",
            evidence: [
              "Inspected the endpoint and fixture code paths.",
              "Ran the focused suites and logged the red test.",
            ],
            checks: [
              {
                name: "Cursor pagination",
                status: "passed",
                detail: "New path passes.",
              },
              {
                name: "Regression suite",
                status: "failed",
                detail: "Offset export test still red.",
              },
              {
                name: "Formatting",
                status: "passed",
                detail: "Lint and format clean.",
              },
            ],
          },
          reportHash: "c".repeat(64),
          launch: fixtureLaunch(true),
        },
      ),
    ],
  });
}

/** Run where downstream tasks wait on an incomplete prerequisite. */
export function waitingRun(): StoredRun {
  return fixtureRun(
    [
      task("api"),
      task("ui", { prerequisites: ["api"] }),
      task("collect", { prerequisites: ["api", "ui"] }),
    ],
    {
      id: "f1151538-5302-4fbf-b50b-f6a55f2a5a45",
      title: "Frontend draw",
      status: "running",
      attempts: [
        fixtureAttempt(
          "api",
          "completed",
          "b410f767-1197-469b-8b89-af35338a4e08",
          {
            report: {
              outcome: "completed",
              summary: "API findings recorded.",
              evidence: ["Cursor behavior verified"],
              checks: [],
            },
            reportHash: "c".repeat(64),
            launch: fixtureLaunch(true),
          },
        ),
      ],
    },
  );
}

/** Run whose only task reported completion while its agent still settles. */
export function finishingRun(): StoredRun {
  return fixtureRun([task("deliver")], {
    id: "f1151538-5302-4fbf-b50b-f6a55f2a5a46",
    title: "Delivery hand-off",
    status: "running",
    attempts: [
      fixtureAttempt(
        "deliver",
        "completed",
        "b410f767-1197-469b-8b89-af35338a4e09",
        {
          report: {
            outcome: "completed",
            summary: "Delivery package handed to the source.",
            evidence: ["Package includes findings and rollback steps"],
            checks: [
              {
                name: "Package review",
                status: "passed",
                detail: "Contents match the expected outcome.",
              },
            ],
          },
          reportHash: "c".repeat(64),
          launch: fixtureLaunch(false),
        },
      ),
    ],
  });
}

/** Run whose accepted graph recorded no tasks. */
export function emptyRun(): StoredRun {
  return fixtureRun([], {
    id: "f1151538-5302-4fbf-b50b-f6a55f2a5a47",
    title: "Empty exploration",
    status: "running",
  });
}

/** Run still in the planning phase with no tasks recorded yet. */
export function planningRun(): StoredRun {
  return fixtureRun([], {
    id: "f1151538-5302-4fbf-b50b-f6a55f2a5a48",
    title: "Planned migration",
    status: "planning",
    orchestration: {
      phase: "planning",
      concurrency: 2,
      requestedBy: null,
      coordinatorLaunch: "pending",
      prompt: "Split the migration goal into tasks",
      notification: null,
    },
  });
}

export const fixtureRuns: Record<string, () => StoredRun> = {
  "long-title": longTitleRun,
  multi: multiTaskRun,
  blocked: blockedRun,
  "failed-checks": failedChecksRun,
  waiting: waitingRun,
  finishing: finishingRun,
  empty: emptyRun,
  planning: planningRun,
};
