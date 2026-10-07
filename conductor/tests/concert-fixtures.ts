import type {
  ConcertAttempt,
  ConcertContext,
  ConcertGraph,
  ConcertPlacement,
  StoredConcert,
  TaskDefinition,
} from "../shared/concerts/models";

export const fixtureConcertId = "f1151538-5302-4fbf-b50b-f6a55f2a5940";
export const planContext: ConcertContext = {
  plan: "Investigate API and UI pagination, then collect the findings.",
  provenance: "Selected source-agent plan",
  decisions: ["Keep cursor pagination"],
  constraints: ["Read only"],
  expectedOutcome: "Reports with evidence and remaining uncertainties",
};
export const placement: ConcertPlacement = {
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
export function graph(): ConcertGraph {
  return {
    tasks: [
      task("api"),
      task("ui"),
      task("collect", { prerequisites: ["api", "ui"] }),
    ],
  };
}
export function storedConcert(): StoredConcert {
  return {
    schemaVersion: 1,
    id: fixtureConcertId,
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
// Each returns a schema-valid, post-acceptance StoredConcert exercising one visible
// state for the preview and browser verification. IDs are fixed so screenshots
// and assertions stay reproducible.

export const longTaskTitle =
  "Migrate the legacy offset-pagination export surface to cursor pagination without dropping any in-flight request mid-cycle";

export function fixtureAttempt(
  taskId: string,
  state: ConcertAttempt["state"],
  id: string,
  patch: Partial<ConcertAttempt> = {},
): ConcertAttempt {
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
): NonNullable<ConcertAttempt["launch"]> {
  return { state, prompt: "Carry out the task and report evidence", settled };
}

/** A long multi-line concert summary that must trigger the Show more control. */
export const longSummary = [
  "Reviewed the export endpoint and the UI fixtures.",
  "Cursor pagination passes; offset pagination stays flagged.",
  "The regression suite still fails on the offset export test.",
  "Recommend finishing the migration before the next release window.",
  "The full evidence trail is recorded in the concert history.",
].join("\n");

function fixtureConcert(
  tasks: TaskDefinition[],
  options: {
    id: string;
    title?: string;
    status?: StoredConcert["status"];
    origin?: NonNullable<StoredConcert["execution"]>["origin"];
    attempts?: ConcertAttempt[];
    summary?: string | null;
    finishedAt?: number | null;
    orchestration?: NonNullable<
      NonNullable<StoredConcert["execution"]>["orchestration"]
    >;
  },
): StoredConcert {
  const base = storedConcert();
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
export function longTitleConcert(): StoredConcert {
  return fixtureConcert([task("migration", { title: longTaskTitle })], {
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
export function multiTaskConcert(): StoredConcert {
  return fixtureConcert(
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

/** Concert with one explicitly blocked task and an actionable message. */
export function blockedConcert(): StoredConcert {
  return fixtureConcert([task("export")], {
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
export function failedChecksConcert(): StoredConcert {
  return fixtureConcert([task("review")], {
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

/** Concert where downstream tasks wait on an incomplete prerequisite. */
export function waitingConcert(): StoredConcert {
  return fixtureConcert(
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

/** Concert whose only task reported completion while its agent still settles. */
export function finishingConcert(): StoredConcert {
  return fixtureConcert([task("deliver")], {
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

/** Concert whose accepted graph recorded no tasks. */
export function emptyConcert(): StoredConcert {
  return fixtureConcert([], {
    id: "f1151538-5302-4fbf-b50b-f6a55f2a5a47",
    title: "Empty exploration",
    status: "running",
  });
}

/** Concert still in the planning phase with no tasks recorded yet. */
export function planningConcert(): StoredConcert {
  return fixtureConcert([], {
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

/**
 * A failed task agent whose report carries a diagnosis and whose attempt already
 * holds a server-granted write, for recovery-state previews and checks.
 */
export function recoveryConcert(): StoredConcert {
  return fixtureConcert([task("repair")], {
    id: "f1151538-5302-4fbf-b50b-f6a55f2a5a49",
    title: "Repair the shared schema",
    status: "blocked",
    attempts: [
      fixtureAttempt(
        "repair",
        "failed",
        "b410f767-1197-469b-8b89-af35338a4e0a",
        {
          message: null,
          report: {
            outcome: "failed",
            summary: "Typecheck still fails in the new RPC handler.",
            evidence: ["npm run typecheck: TS2345 in server/rpc.ts:41"],
            checks: [
              {
                name: "typecheck",
                status: "failed",
                detail: "TS2345 in server/rpc.ts:41",
              },
            ],
            diagnosis: {
              tried: ["Narrowed the input type", "Regenerated the schema"],
              suspectedCause: "shared/schema.ts exports the old shape",
              need: "scope",
              requestedWrites: ["shared/schema.ts"],
            },
          },
          reportHash: "d".repeat(64),
          grantedWrites: [
            {
              path: "shared/schema.ts",
              reason: "Typecheck reads the exported schema",
              at: 1791201660000,
            },
          ],
          nudgedAt: 1791201655000,
          launch: fixtureLaunch(true),
        },
      ),
    ],
  });
}

export const fixtureConcerts: Record<string, () => StoredConcert> = {
  "long-title": longTitleConcert,
  multi: multiTaskConcert,
  blocked: blockedConcert,
  "failed-checks": failedChecksConcert,
  waiting: waitingConcert,
  finishing: finishingConcert,
  empty: emptyConcert,
  planning: planningConcert,
  recovery: recoveryConcert,
};
