import { useState, useSyncExternalStore } from "react";
import type { PodiumSession } from "../../client/podium/session";
import type { SymphoniesData } from "../../client/symphonies/list";
import type { ProfilesData } from "../../client/symphonies/profiles";
import {
  summarizeSymphony,
  type Attempt,
  type StoredSymphony,
  type SymphonyContext,
  type TaskFinding,
} from "../../shared/symphonies/models";
import type {
  ConductorProfile,
  ProfilesState,
} from "../../shared/symphonies/profiles";
import { providerCatalogSchema } from "../../shared/symphonies/profiles-rpc";
import {
  fixtureAttempt,
  fixtureLaunch,
  fixtureSymphonies,
  planContext,
  recoverySymphony,
  storedSymphony,
  task,
} from "../symphony-fixtures";

/**
 * Preview-only fixture extensions kept out of the shared fixture record:
 * states the production fixtures do not carry a scenario for, so the browser
 * checks and screenshots can reach them through `?symphony-fixture=`.
 */
const extendedFixtureSymphonies: Record<string, () => StoredSymphony> = {
  // Work/blocked durations and token usage: one task with a blocked full
  // attempt plus a tracked partial one, one legacy task recorded before
  // blocked time and usage existed. All times are settled, so the rendered
  // labels are deterministic.
  metrics: () => {
    const implement = task("export", {
      title: "Export the pagination report",
      worker: { role: "implementation", profile: "default" },
      writes: ["server/export.ts"],
    });
    const docs = task("docs", {
      title: "Document the report format",
      worker: { role: "exploration", profile: "default" },
    });
    const cache = task("cache", {
      title: "Cache the report responses",
      worker: { role: "implementation", profile: "default" },
      writes: ["server/cache.ts"],
    });
    const base = storedSymphony();
    return {
      ...base,
      id: "f1151538-5302-4fbf-b50b-f6a55f2a5c31",
      title: "Usage and duration fixtures",
      status: "completed",
      revisions: [
        {
          number: 1,
          parent: null,
          reason: "Conductor task breakdown",
          acceptedAt: LOOP_T0,
          score: { tasks: [implement, docs, cache] },
        },
      ],
      execution: {
        origin: "conducted",
        attempts: [
          loopAttempt("export", "completed", 1, 1, 204, {
            // 12m of work either side of a 3h blocker, then completion.
            startedAt: LOOP_T0,
            blocked: [
              {
                from: LOOP_T0 + 12 * LOOP_MINUTE,
                to: LOOP_T0 + 192 * LOOP_MINUTE,
              },
            ],
            usage: {
              input: 48_000,
              cached: 40_000,
              output: 6_000,
              collectedAt: LOOP_T0 + 205 * LOOP_MINUTE,
            },
            report: {
              outcome: "completed",
              summary: "Export endpoint streams the pagination report.",
              evidence: ["export tests pass"],
              checks: [
                { name: "export test", status: "passed", detail: "green" },
              ],
            },
          }),
          loopAttempt("export", "completed", 2, 1, 248, {
            // A retry that never blocked and reported no cached tokens.
            startedAt: LOOP_T0 + 240 * LOOP_MINUTE,
            blocked: [],
            usage: {
              input: 14_000,
              output: 2_000,
              collectedAt: LOOP_T0 + 249 * LOOP_MINUTE,
            },
            report: {
              outcome: "completed",
              summary: "Finished the export after the blocker cleared.",
              evidence: ["export tests pass"],
              checks: [
                { name: "export test", status: "passed", detail: "green" },
              ],
            },
          }),
          // A record stored before blocked time and usage were tracked.
          loopAttempt("docs", "completed", 3, 1, 305, {
            report: {
              outcome: "completed",
              summary: "Documented the report format.",
              evidence: ["docs reviewed"],
              checks: [],
            },
          }),
          // An attempt whose reader only learned the cached count: no input
          // or output, so its cached sum must stand alone, never as "—".
          loopAttempt("cache", "completed", 4, 1, 312, {
            blocked: [],
            usage: {
              cached: 40_000,
              collectedAt: LOOP_T0 + 313 * LOOP_MINUTE,
            },
            report: {
              outcome: "completed",
              summary: "Cached the report responses.",
              evidence: ["cache test passes"],
              checks: [],
            },
          }),
        ],
        summary: "Export and docs completed.",
        finishedAt: LOOP_T0 + 320 * LOOP_MINUTE,
        interruption: null,
      },
    };
  },
  "agent-reuse": () => {
    const symphony = recoverySymphony();
    const attempt = symphony.execution.attempts[0];
    if (!attempt) {
      return symphony;
    }
    // Same task and same agent as the latest attempt: an earlier failed fix
    // round that reused the agent after a retry dispatch.
    const prior = structuredClone(attempt);
    prior.id = "b410f767-1197-469b-8b89-af35338a4e0b";
    prior.state = "failed";
    prior.startedAt = attempt.startedAt - 10 * 60_000;
    prior.endedAt = attempt.startedAt - 5 * 60_000;
    delete prior.grantedWrites;
    delete prior.nudgedAt;
    prior.launch = {
      state: "started",
      profile: "inherit",
      generation: 0,
      prompt: "Carry out the task and report evidence",
      settled: true,
    };
    symphony.execution.attempts.unshift(prior);
    return symphony;
  },
  "recovery-retry": () => {
    const symphony = recoverySymphony();
    const failed = symphony.execution.attempts[0];
    if (!failed) {
      return symphony;
    }
    failed.endedAt = failed.startedAt + 5 * 60_000;
    // A legacy record: an older Conductor `addWrites` grew the task through a
    // second revision, so no attempt carries the paths. The Context tab names
    // the grown task; the History rows cannot attribute the paths.
    const grown = structuredClone(symphony.revisions[0]);
    if (grown) {
      grown.number = 2;
      grown.parent = 1;
      grown.reason = "Conductor added write scope: shared/helper.ts";
      grown.acceptedAt = failed.endedAt + 60_000;
      grown.score = {
        tasks: grown.score.tasks.map((task) =>
          task.id === "repair"
            ? { ...task, writes: ["shared/helper.ts"] }
            : task,
        ),
      };
      symphony.revisions.push(grown);
    }
    // The fresh successful retry on another agent. Its History row carries no
    // scope line because the legacy record stored the paths on no attempt.
    const retry = structuredClone(failed);
    retry.id = "b410f767-1197-469b-8b89-af35338a4e0c";
    retry.agentId = "worker-repair-2";
    retry.state = "completed";
    retry.startedAt = failed.endedAt + 5 * 60_000;
    retry.endedAt = retry.startedAt + 5 * 60_000;
    retry.message = null;
    delete retry.grantedWrites;
    delete retry.nudgedAt;
    retry.report = {
      outcome: "completed",
      summary: "Typecheck passes after the shared helper change.",
      evidence: ["npm run typecheck: clean"],
      checks: [{ name: "typecheck", status: "passed", detail: "clean" }],
    };
    retry.reportHash = "e".repeat(64);
    retry.launch = {
      state: "started",
      profile: "inherit",
      generation: 0,
      prompt: "Carry out the task and report evidence",
      settled: true,
    };
    symphony.execution.attempts.push(retry);
    symphony.status = "completed";
    return symphony;
  },
  "changed-paths": () => {
    const symphony = recoverySymphony();
    const failed = symphony.execution.attempts[0];
    if (!failed) {
      return symphony;
    }
    failed.endedAt = failed.startedAt + 5 * 60_000;
    // The failed attempt's write-scope fingerprint diff: a small uncapped
    // change set, listed in full on the attempt row.
    failed.changedPaths = ["server/rpc.ts", "shared/schema.ts"];
    // The completed retry on a new agent changed more paths than the stored
    // cap keeps, so its row lists the kept paths with a "+ more" indicator.
    const retry = structuredClone(failed);
    retry.id = "b410f767-1197-469b-8b89-af35338a4e0e";
    retry.agentId = "worker-repair-2";
    retry.state = "completed";
    retry.startedAt = failed.endedAt + 5 * 60_000;
    retry.endedAt = retry.startedAt + 5 * 60_000;
    retry.message = null;
    delete retry.grantedWrites;
    delete retry.nudgedAt;
    retry.changedPaths = [
      "shared/schema.ts",
      "server/rpc.ts",
      "server/handlers/export.ts",
      "client/export/cursor.ts",
      "tests/export.test.ts",
    ];
    retry.changedPathsTruncated = true;
    retry.report = {
      outcome: "completed",
      summary: "Typecheck and the export tests pass after the schema change.",
      evidence: ["npm run typecheck: clean; export tests pass"],
      checks: [{ name: "typecheck", status: "passed", detail: "clean" }],
    };
    retry.reportHash = "e".repeat(64);
    retry.launch = {
      state: "started",
      profile: "inherit",
      generation: 0,
      prompt: "Carry out the task and report evidence",
      settled: true,
    };
    symphony.execution.attempts.push(retry);
    symphony.status = "completed";
    return symphony;
  },
  "retry-added": () => {
    const symphony = recoverySymphony();
    const failed = symphony.execution.attempts[0];
    if (!failed) {
      return symphony;
    }
    failed.endedAt = failed.startedAt + 5 * 60_000;
    const retry = structuredClone(failed);
    retry.id = "b410f767-1197-469b-8b89-af35338a4e0d";
    retry.agentId = "worker-repair-2";
    retry.state = "completed";
    retry.startedAt = failed.endedAt + 5 * 60_000;
    retry.endedAt = retry.startedAt + 5 * 60_000;
    retry.message = null;
    delete retry.grantedWrites;
    delete retry.nudgedAt;
    retry.addedWrites = [
      {
        path: "shared/helper.ts",
        reason: "needs the exported type",
        at: retry.startedAt,
      },
    ];
    retry.report = {
      outcome: "completed",
      summary: "Typecheck passes after the shared helper change.",
      evidence: ["npm run typecheck: clean"],
      checks: [{ name: "typecheck", status: "passed", detail: "clean" }],
    };
    retry.reportHash = "e".repeat(64);
    retry.launch = {
      state: "started",
      profile: "inherit",
      generation: 0,
      prompt: "Carry out the task and report evidence",
      settled: true,
    };
    symphony.execution.attempts.push(retry);
    symphony.status = "completed";
    return symphony;
  },
};

function fixtureSymphonyByName(
  fixture: string,
): (() => StoredSymphony) | undefined {
  return extendedFixtureSymphonies[fixture] ?? fixtureSymphonies[fixture];
}

const LOOP_T0 = 1791201600000;
const LOOP_MINUTE = 60_000;

/** A reviewed defect; the reviewer `` `review` `` reports it against `taskId`. */
function loopFinding(
  id: string,
  severity: TaskFinding["severity"],
  taskId: string,
  paths: string[],
  summary: string,
  suggestedFix?: string,
): TaskFinding {
  return {
    id,
    severity,
    ...(taskId ? { taskId } : {}),
    paths,
    summary,
    ...(suggestedFix ? { suggestedFix } : {}),
  };
}

/** One settled attempt, printable in History rows and task cards. */
function loopAttempt(
  taskId: string,
  state: StoredSymphony["execution"]["attempts"][number]["state"],
  index: number,
  loop: number,
  minutes: number,
  extra: Partial<
    NonNullable<StoredSymphony["execution"]["attempts"][number]>
  > = {},
): NonNullable<StoredSymphony["execution"]["attempts"][number]> {
  return {
    id: `b410f767-1197-469b-8b89-af35338a4ec${index}`,
    taskId,
    agentId: `worker-${taskId}`,
    state,
    startedAt: LOOP_T0 + (minutes - 10) * LOOP_MINUTE,
    endedAt: LOOP_T0 + minutes * LOOP_MINUTE,
    message: null,
    report: null,
    reportHash: "c".repeat(64),
    loop,
    launch: fixtureLaunch(true),
    ...extra,
  };
}

/**
 * A needs-changes implementation task: the work ran and the agent's own fix
 * rounds exhausted, so a required check still fails and a blocking finding is
 * attached. Its label and amber state must stay distinct from failed.
 */
const needsChangesSymphony = (): StoredSymphony => {
  const api = task("api", {
    worker: { role: "implementation", profile: "default" },
    writes: ["server/symphonies"],
  });
  const base = storedSymphony();
  return {
    ...base,
    id: "f1151538-5302-4fbf-b50b-f6a55f2a5c21",
    title: "Contract validation rewrite",
    status: "running",
    revisions: [
      {
        number: 1,
        parent: null,
        reason: "Conductor task breakdown",
        acceptedAt: LOOP_T0,
        score: { tasks: [api] },
      },
    ],
    execution: {
      origin: "conducted",
      attempts: [
        loopAttempt("api", "needs-changes", 1, 1, 25, {
          report: {
            outcome: "needs-changes",
            summary:
              "Implemented the validation rewrite, but the focused contract test still fails after three fix rounds.",
            evidence: ["npm test -- contract: 1 red on the 400 path"],
            checks: [
              {
                name: "contract test",
                status: "failed",
                detail: "expected 400 for an unknown concert, received 500",
              },
            ],
            findings: [
              loopFinding(
                "F1",
                "blocking",
                "api",
                ["server/symphonies/execution.ts:112"],
                "The unknown-concert branch rethrows instead of returning the 400 contract shape.",
                "Map SymphonyError 404 cases to the 400 payload with the stable code.",
              ),
            ],
          },
        }),
      ],
      summary: null,
      finishedAt: null,
      interruption: null,
    },
  };
};

/**
 * The full loop flow: loop 1's review reports blocking findings, loop 2
 * reopens the owning tasks and the review re-checks them, a follow-up finding
 * from that re-check drives loop 3, which the user approved past the budget.
 * Loop 3 succeeds and the symphony finishes.
 */
const loopsSymphony = (): StoredSymphony => {
  const api = task("api", {
    worker: { role: "implementation", profile: "default" },
  });
  const ui = task("ui", {
    worker: { role: "implementation", profile: "default" },
  });
  const review = task("review", {
    prerequisites: ["api", "ui"],
    worker: { role: "review", profile: "default" },
    review: true,
  });
  const findingF1 = loopFinding(
    "F1",
    "blocking",
    "api",
    ["conductor/server/symphonies/orchestration.ts:789"],
    "A completed task cannot get another attempt, so review defects are unfixable.",
    "Accept needs-changes latest attempts in the reopen path.",
  );
  const findingF2 = loopFinding(
    "F2",
    "blocking",
    "ui",
    ["conductor/client/symphonies/task-card.tsx:41"],
    "The task card state palette lacks a needs-changes entry, so the type check fails.",
    "Extend the record and reuse the warning hue.",
  );
  const findingF3 = loopFinding(
    "F3",
    "blocking",
    "api",
    ["conductor/server/symphonies/orchestration.ts:1223"],
    "The constant wake identity means the second clean pass cannot wake the Conductor.",
  );
  const base = storedSymphony();
  return {
    ...base,
    id: "f1151538-5302-4fbf-b50b-f6a55f2a5c22",
    title: "Review loop fix campaign",
    status: "completed",
    revisions: [
      {
        number: 1,
        parent: null,
        reason: "Conductor task breakdown",
        acceptedAt: LOOP_T0,
        score: { tasks: [api, ui, review] },
      },
    ],
    execution: {
      origin: "conducted",
      conducting: {
        phase: "working",
        concurrency: 2,
        requestedBy: null,
        conductor: "agent",
        conductorLaunch: "started",
        prompt: "Coordinate the pagination fix campaign",
        notification: "loop-end:3",
        maxLoops: 2,
        loops: [
          {
            number: 2,
            reason: "Fix review findings F1 and F2",
            startedAt: LOOP_T0 + 45 * LOOP_MINUTE,
            reopened: [
              {
                taskId: "api",
                findings: ["F1"],
                worker: { profile: "opus" },
                routing: {
                  reason:
                    "Escalated after two bounded fix rounds hit the same limitation",
                  selectedBy: "conductor",
                  override: {
                    category: "observed-limitation",
                    evidence:
                      "Loop 1's two corrective attempts failed on the same wake identity defect.",
                  },
                },
              },
              { taskId: "ui", findings: ["F2"] },
            ],
            added: [],
            deferred: [],
          },
          {
            number: 3,
            reason: "Fix the follow-up finding F3 found while re-checking",
            startedAt: LOOP_T0 + 120 * LOOP_MINUTE,
            reopened: [{ taskId: "api", findings: ["F3"] }],
            added: [],
            deferred: [],
            approval: {
              loops: 3,
              userAnswer: "Yes, run one more loop to fix F3.",
            },
          },
        ],
      },
      attempts: [
        loopAttempt("api", "completed", 1, 1, 55, {
          report: {
            outcome: "completed",
            summary: "Hooked the pagination contract up to the export API.",
            evidence: ["contract tests pass"],
            checks: [
              { name: "contract test", status: "passed", detail: "green" },
            ],
          },
        }),
        loopAttempt("ui", "completed", 2, 1, 50, {
          report: {
            outcome: "completed",
            summary: "Rendered the pagination controls with fixtures.",
            evidence: ["focused UI suite passes"],
            checks: [{ name: "UI suite", status: "passed", detail: "green" }],
          },
        }),
        loopAttempt("review", "needs-changes", 3, 1, 40, {
          report: {
            outcome: "needs-changes",
            summary: "Both findings from the first code review remain.",
            evidence: ["Read the diff against the task scope"],
            checks: [],
            findings: [findingF1, findingF2],
          },
        }),
        loopAttempt("api", "completed", 4, 2, 100, {
          reopen: {
            reason:
              "Fix review finding F1 — accept needs-changes latest attempts.",
            findings: [findingF1],
          },
          report: {
            outcome: "completed",
            summary: "Reopened tasks now report needs-changes attempts.",
            evidence: ["re-open contract test passes"],
            checks: [
              { name: "reopen path", status: "passed", detail: "green" },
            ],
          },
        }),
        loopAttempt("ui", "completed", 5, 2, 95, {
          reopen: {
            reason:
              "Fix review finding F2 — add the needs-changes palette entry.",
            findings: [findingF2],
          },
          report: {
            outcome: "completed",
            summary: "The task card renders the amber needs-changes state.",
            evidence: ["typecheck passes"],
            checks: [{ name: "typecheck", status: "passed", detail: "green" }],
          },
        }),
        loopAttempt("review", "needs-changes", 6, 2, 115, {
          reopen: {
            reason:
              "Confirm F1 and F2 are fixed and re-check against the new code.",
            findings: [findingF1, findingF2],
          },
          recheck: true,
          report: {
            outcome: "needs-changes",
            summary:
              "F1 and F2 are fixed, but the re-check found a follow-up defect.",
            evidence: ["Read the loop 2 diff"],
            checks: [],
            findings: [findingF3],
          },
        }),
        loopAttempt("api", "completed", 7, 3, 175, {
          reopen: {
            reason:
              "Fix the follow-up finding F3 — use a per-loop wake identity.",
            findings: [findingF3],
          },
          report: {
            outcome: "completed",
            summary: "The wake identity is now per loop.",
            evidence: ["wake loop test passes"],
            checks: [{ name: "wake test", status: "passed", detail: "green" }],
          },
        }),
        loopAttempt("review", "completed", 8, 3, 190, {
          reopen: {
            reason: "Confirm F3 is fixed and re-check the final state.",
            findings: [findingF3],
          },
          recheck: true,
          report: {
            outcome: "completed",
            summary:
              "All three findings are fixed; no blocking defect remains.",
            evidence: ["Re-read the loop 3 diff"],
            checks: [],
          },
        }),
      ],
      summary:
        "Loops 1 and 2 needed changes; the user approved loop 3 past the budget and the review finished without blocking findings.",
      finishedAt: LOOP_T0 + 300 * LOOP_MINUTE,
      interruption: null,
    },
  };
};

/** A symphony the user stopped with open findings and a non-completed task. */
const unresolvedSymphony = (): StoredSymphony => {
  const api = task("api", {
    worker: { role: "implementation", profile: "default" },
  });
  const base = storedSymphony();
  return {
    ...base,
    id: "f1151538-5302-4fbf-b50b-f6a55f2a5c23",
    title: "Pagination stop decision",
    status: "failed",
    revisions: [
      {
        number: 1,
        parent: null,
        reason: "Conductor task breakdown",
        acceptedAt: LOOP_T0,
        score: { tasks: [api] },
      },
    ],
    execution: {
      origin: "conducted",
      attempts: [
        loopAttempt("api", "needs-changes", 1, 1, 30, {
          report: {
            outcome: "needs-changes",
            summary: "One contract check still fails after the fix rounds.",
            evidence: ["npm test -- contract: 1 red"],
            checks: [
              {
                name: "contract test",
                status: "failed",
                detail: "red on the 400 path",
              },
            ],
            findings: [
              loopFinding(
                "F1",
                "blocking",
                "api",
                ["conductor/server/symphonies/execution.ts:282"],
                "Finish still requires every latest attempt to be completed.",
              ),
            ],
          },
        }),
      ],
      summary: "Stopped by the user with one open finding and one open task.",
      finishedAt: LOOP_T0 + 120 * LOOP_MINUTE,
      interruption: null,
      unresolved: [
        {
          finding: "api#F1",
          reason: "Needs a product decision on the 400 shape.",
        },
        { taskId: "api", reason: "User chose to stop instead of looping." },
      ],
    },
  };
};

Object.assign(extendedFixtureSymphonies, {
  "needs-changes": needsChangesSymphony,
  loops: loopsSymphony,
  unresolved: unresolvedSymphony,
});

/** A routing catalog revision hash; only its display prefix is asserted. */
const routingRevision =
  "c9a1f7d2e6b34a0591c8d3e2f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3";

/** A task routing decision whose launch mirrors it, as the server stores. */
function routedLaunch(
  profile: string,
  extra: Partial<NonNullable<Attempt["launch"]>> = {},
): NonNullable<Attempt["launch"]> {
  return {
    state: "started",
    profile,
    generation: 0,
    prompt: "Carry out the task and report evidence",
    settled: true,
    ...extra,
  };
}

/**
 * Routing decisions across one symphony: a smaller-first routed task, a
 * Conductor choice with a user-choice override and a larger-than-eligible
 * warning, a chosen review profile reported as unclassified, and a legacy
 * task and attempt with no routing fields that must render exactly as before.
 */
const routedSymphony = (): StoredSymphony => {
  const api = task("api", {
    title: "Export the routing catalog",
    worker: { role: "implementation", profile: "starter" },
    routing: {
      role: "implementation",
      domains: ["typescript"],
      reason: "First eligible implementation profile for the TypeScript domain",
      selectedBy: "route",
      catalogRevision: routingRevision,
    },
  });
  const ui = task("ui", {
    title: "Migrate the export surface to cursor pagination",
    worker: { role: "implementation", profile: "opus" },
    routing: {
      role: "implementation",
      reason: "The user asked for Opus for this migration in the request",
      selectedBy: "conductor",
      override: {
        category: "user-choice",
        evidence: "The original request says: run the migration on Opus.",
      },
      catalogRevision: routingRevision,
      warnings: [
        {
          code: "larger-than-eligible",
          message:
            'Task "ui": opus is larger than the smaller-first pick starter.',
        },
      ],
    },
  });
  const review = task("review", {
    title: "Review the routing display",
    prerequisites: ["api", "ui"],
    worker: { role: "review", profile: "docs" },
    review: true,
    routing: {
      role: "review",
      reason: "Only docs was free for the review pass",
      selectedBy: "conductor",
      catalogRevision: routingRevision,
      warnings: [
        {
          code: "unclassified-profile",
          message:
            'Task "review": profile docs has no routing.json entry, so it is reported as unclassified.',
        },
      ],
    },
  });
  // An old record: stored before routing existed, so it renders as before.
  const collect = task("collect", { prerequisites: ["api"] });
  // A waiting record: no attempt yet, so the card falls back to the task
  // definition's stored routing decision.
  const notes = task("notes", {
    title: "Note the takeover outcome",
    prerequisites: ["api"],
    worker: { role: "exploration", profile: "starter" },
    routing: {
      role: "exploration",
      reason: "Queued behind the api takeover",
      selectedBy: "route",
      catalogRevision: routingRevision,
    },
  });
  const base = storedSymphony();
  return {
    ...base,
    id: "f1151538-5302-4fbf-b50b-f6a55f2a5c26",
    title: "Routed pagination work",
    status: "running",
    revisions: [
      {
        number: 1,
        parent: null,
        reason: "Conductor task breakdown",
        acceptedAt: LOOP_T0,
        score: { tasks: [api, ui, review, collect, notes] },
      },
    ],
    execution: {
      origin: "conducted",
      conducting: {
        phase: "working",
        concurrency: 2,
        requestedBy: null,
        conductor: "agent",
        conductorLaunch: "started",
        prompt: "Coordinate the routed pagination work",
        notification: null,
        maxLoops: 3,
        loops: [
          {
            number: 2,
            reason: "Take api over with an inline model after loop 1 failed",
            startedAt: LOOP_T0 + 30 * LOOP_MINUTE,
            reopened: [
              {
                taskId: "api",
                findings: [],
                // The server's real takeover shape: the "inherit" sentinel
                // alongside the inline provider/model choice.
                worker: {
                  profile: "inherit",
                  provider: "openai",
                  model: "gpt-6-sol",
                },
                routing: {
                  reason:
                    "Escalated to inline after bounded smaller-worker failures",
                  selectedBy: "conductor",
                  override: {
                    category: "observed-limitation",
                    evidence:
                      "Both corrective attempts on starter failed the same bundle parse check.",
                  },
                },
              },
            ],
            added: [],
            deferred: [],
          },
        ],
      },
      attempts: [
        // Failed smaller-worker run: the reason loop 2 took the task over.
        loopAttempt("api", "failed", 1, 1, 25, {
          message: "Starter failed the bundle parse check twice.",
          launch: routedLaunch("starter", {
            catalogRevision: routingRevision,
            routing: {
              reason:
                "First eligible implementation profile for the TypeScript domain",
              selectedBy: "route",
            },
          }),
        }),
        // The loop-2 takeover now runs: the card shows this attempt's launch
        // choice and routing, not the task definition's original pick.
        loopAttempt("api", "running", 5, 2, 40, {
          reopen: {
            reason: "Fix the repeated bundle parse failure on an inline model.",
            findings: [],
          },
          launch: routedLaunch("inherit", {
            provider: "openai",
            model: "gpt-6-sol",
            thinkingOptionId: "high",
            catalogRevision: routingRevision,
            routing: {
              reason:
                "Escalated to inline after bounded smaller-worker failures",
              selectedBy: "conductor",
              override: {
                category: "observed-limitation",
                evidence:
                  "Both corrective attempts on starter failed the same bundle parse check.",
              },
            },
            warnings: [
              {
                code: "unconfigured-model",
                message:
                  'Task "api": inline openai/gpt-6-sol has no routing classification.',
              },
            ],
          }),
        }),
        loopAttempt("ui", "completed", 2, 1, 30, {
          report: {
            outcome: "completed",
            summary: "The migration runs on Opus as the user asked.",
            evidence: ["focused export suite passes"],
            checks: [{ name: "UI suite", status: "passed", detail: "green" }],
          },
          launch: routedLaunch("opus", {
            catalogRevision: routingRevision,
            routing: {
              reason:
                "The user asked for Opus for this migration in the request",
              selectedBy: "conductor",
              override: {
                category: "user-choice",
                evidence:
                  "The original request says: run the migration on Opus.",
              },
            },
            warnings: [
              {
                code: "larger-than-eligible",
                message:
                  'Task "ui": opus is larger than the smaller-first pick starter.',
              },
            ],
          }),
        }),
        loopAttempt("review", "completed", 3, 1, 20, {
          report: {
            outcome: "completed",
            summary: "The routing display reads cleanly on cards and history.",
            evidence: ["Read the rendered cards"],
            checks: [],
          },
          launch: routedLaunch("docs", {
            catalogRevision: routingRevision,
            routing: {
              reason: "Only docs was free for the review pass",
              selectedBy: "conductor",
            },
            warnings: [
              {
                code: "unclassified-profile",
                message:
                  'Task "review": profile docs has no routing.json entry, so it is reported as unclassified.',
              },
            ],
          }),
        }),
        loopAttempt("collect", "completed", 4, 1, 15, {
          report: {
            outcome: "completed",
            summary: "Collected the findings with no routing fields stored.",
            evidence: ["Read the recorded findings"],
            checks: [],
          },
          launch: fixtureLaunch(true),
        }),
      ],
      summary: null,
      finishedAt: null,
      interruption: null,
    },
  };
};

Object.assign(extendedFixtureSymphonies, { routing: routedSymphony });

Object.assign(extendedFixtureSymphonies, {
  /** The profile a rename or delete removed: definition, launch and takeover
   * lines still render the stored name snapshot, never a raw id. */
  "profile-snapshot": () => {
    const symphony = routedSymphony();
    const apiTask = symphony.revisions[0]?.score.tasks.find(
      (task) => task.id === "api",
    );
    if (apiTask) {
      apiTask.worker = {
        ...apiTask.worker,
        profile: "aa100000-0000-4000-8000-000000000009",
        profileName: "Deep reviewer",
      };
    }
    const failedApi = symphony.execution.attempts.find(
      (attempt) => attempt.taskId === "api" && attempt.state === "failed",
    );
    if (failedApi?.launch) {
      failedApi.launch = {
        ...failedApi.launch,
        profile: "aa100000-0000-4000-8000-000000000009",
        profileName: "Deep reviewer",
      };
    }
    return symphony;
  },
});

/**
 * Two loops whose displayed scores genuinely differ: loop 2 appended the api
 * task (`added`), so the graph for loop 1 shows only ui while the latest loop
 * shows ui plus api. The graph-selection invalidation regression uses this to
 * pick a latest-loop task, step back to a loop without it, and return.
 */
const loopScoresSymphony = (): StoredSymphony => {
  const api = task("api", {
    worker: { role: "implementation", profile: "default" },
  });
  const ui = task("ui", {
    worker: { role: "implementation", profile: "default" },
  });
  const base = storedSymphony();
  return {
    ...base,
    id: "f1151538-5302-4fbf-b50b-f6a55f2a5c24",
    title: "Loop score revision",
    status: "running",
    revisions: [
      {
        number: 1,
        parent: null,
        reason: "Conductor task breakdown",
        acceptedAt: LOOP_T0,
        score: { tasks: [ui] },
      },
      {
        number: 2,
        parent: 1,
        reason: "Loop 2 appended the api task for the user-approved fix",
        acceptedAt: LOOP_T0 + 60 * LOOP_MINUTE,
        score: { tasks: [ui, api] },
      },
    ],
    execution: {
      origin: "conducted",
      conducting: {
        phase: "working",
        concurrency: 2,
        requestedBy: null,
        conductor: "agent",
        conductorLaunch: "started",
        prompt: "Coordinate the loop fix",
        notification: "loop-end:1",
        maxLoops: 3,
        loops: [
          {
            number: 2,
            reason: "Fix the api offset handling found in loop 1",
            startedAt: LOOP_T0 + 45 * LOOP_MINUTE,
            reopened: [{ taskId: "api", findings: ["api#F1"] }],
            added: ["api"],
            deferred: [],
          },
        ],
      },
      attempts: [
        loopAttempt("ui", "needs-changes", 1, 1, 30, {
          report: {
            outcome: "needs-changes",
            summary: "The ui findings stand; the api task must run too.",
            evidence: ["Read the loop 1 report"],
            checks: [],
          },
        }),
        loopAttempt("api", "running", 2, 2, 70, {
          launch: fixtureLaunch(true),
          reopen: {
            reason: "Fix review finding F1 — add the missing api task.",
            findings: [
              loopFinding(
                "F1",
                "blocking",
                "api",
                ["conductor/server/symphonies/execution.ts:41"],
                "The api task reports nothing yet; the fix plan needs the task in the score.",
              ),
            ],
          },
        }),
      ],
      summary: null,
      finishedAt: null,
      interruption: null,
    },
  };
};

Object.assign(extendedFixtureSymphonies, {
  "loop-scores": loopScoresSymphony,
});

// === Worker identity fixtures ===
// One task per worker-identity resolution path the graph nodes render: a
// resolved launch snapshot (claude), an inline launch choice (codex), an
// inline planned worker (pi-plan), a profile-named planned worker
// (planner-plan), an unresolvable worker (api), and an unmarked provider with
// a long model name on a long task id (migrate-cursor-pagination-export).

const WORKER_T0 = 1791201600000;
/** Profile ids are UUIDs; fixed so assertions and screenshots stay stable. */
const WORKER_PLANNER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/** The provider catalog behind the worker fixture's labels. */
export const WORKER_FIXTURE_PROVIDERS = providerCatalogSchema.parse({
  providers: [
    {
      id: "claude",
      label: "Claude",
      available: true,
      status: "ready",
      defaultModeId: null,
      models: [
        {
          id: "claude-opus-4-6",
          label: "Opus 5.5",
          isDefault: true,
          thinkingOptions: [
            { id: "standard", label: "Standard", isDefault: true },
            { id: "extended", label: "Extended", isDefault: false },
          ],
        },
      ],
      modes: [],
    },
    {
      id: "codex",
      label: "Codex",
      available: true,
      status: "ready",
      defaultModeId: null,
      models: [
        {
          id: "codex-max",
          label: "Codex Max",
          isDefault: true,
          thinkingOptions: [],
        },
      ],
      modes: [],
    },
    {
      id: "pi",
      label: "Pi",
      available: true,
      status: "ready",
      defaultModeId: null,
      models: [
        {
          id: "pi-5",
          label: "Pi 5",
          isDefault: true,
          thinkingOptions: [
            { id: "standard", label: "Standard", isDefault: true },
          ],
        },
      ],
      modes: [],
    },
    {
      id: "deepseek",
      label: "DeepSeek",
      available: true,
      status: "ready",
      defaultModeId: null,
      models: [
        {
          id: "deepseek-v4-flash-turbo",
          label: "DeepSeek V4 Flash",
          isDefault: true,
          thinkingOptions: [],
        },
      ],
      modes: [],
    },
  ],
});

const WORKER_PLANNER_PROFILE: ConductorProfile = {
  id: WORKER_PLANNER_ID,
  name: "Planner",
  notes: "",
  provider: "claude",
  model: "claude-opus-4-6",
  thinkingOptionId: "extended",
  routing: null,
  instructions: "",
};

const WORKER_FIXTURE_STATE: ProfilesState = {
  revision: "b".repeat(64),
  catalogRevision: "c".repeat(64),
  mode: "warn",
  state: "valid",
  profiles: [WORKER_PLANNER_PROFILE],
  diagnostics: [],
};

/**
 * Static profiles data for the worker fixture: the graph only reads the
 * store state and the provider catalog, so every mutation rejects.
 */
export const workerFixtureProfiles: ProfilesData = {
  state: WORKER_FIXTURE_STATE,
  loading: false,
  stale: false,
  providers: WORKER_FIXTURE_PROVIDERS,
  save: async () => {
    throw new Error("This fixture's profiles are read-only.");
  },
  remove: async () => {
    throw new Error("This fixture's profiles are read-only.");
  },
  setMode: async () => {
    throw new Error("This fixture's profiles are read-only.");
  },
  importPaseo: async () => {
    throw new Error("This fixture's profiles are read-only.");
  },
  previewPaseoSync: async () => {
    throw new Error("This fixture's profiles are read-only.");
  },
  syncPaseo: async () => {
    throw new Error("This fixture's profiles are read-only.");
  },
  refresh: async () => WORKER_FIXTURE_STATE,
};

const workersSymphony = (): StoredSymphony => {
  const base = storedSymphony();
  const attempt = (
    taskId: string,
    id: string,
    state: Attempt["state"],
    launch: NonNullable<Attempt["launch"]>,
  ): Attempt => ({
    ...fixtureAttempt(taskId, state, id),
    launch,
  });
  return {
    ...base,
    id: "f1151538-5302-4fbf-b50b-f6a55f2a5d01",
    title: "Worker identity tour",
    status: "running",
    revisions: [
      {
        number: 1,
        parent: null,
        reason: "Conductor task breakdown",
        acceptedAt: WORKER_T0,
        score: {
          tasks: [
            task("api"),
            task("claude", {
              worker: {
                role: "implementation",
                profile: WORKER_PLANNER_ID,
                profileName: "Planner",
              },
            }),
            task("codex"),
            task("pi-plan", {
              worker: {
                role: "exploration",
                profile: "inherit",
                provider: "pi",
                model: "pi-5",
                thinkingOptionId: "standard",
              },
            }),
            task("planner-plan", {
              worker: {
                role: "implementation",
                profile: WORKER_PLANNER_ID,
                profileName: "Planner",
              },
            }),
            task("migrate-cursor-pagination-export", {
              title: "Migrate the export to cursor pagination",
              worker: {
                role: "implementation",
                profile: "deepseek",
              },
            }),
          ],
        },
      },
    ],
    execution: {
      origin: "tracked",
      attempts: [
        attempt("claude", "b410f767-1197-469b-8b89-af35338a4ed1", "running", {
          ...fixtureLaunch(false),
          profile: WORKER_PLANNER_ID,
          profileId: WORKER_PLANNER_ID,
          profileName: "Planner",
          // The snapshot of what the profile actually resolved to at launch.
          resolved: {
            provider: "claude",
            model: "claude-opus-4-6",
            thinkingOptionId: "extended",
          },
        }),
        attempt("codex", "b410f767-1197-469b-8b89-af35338a4ed2", "completed", {
          ...fixtureLaunch(false),
          // An inline choice: only the launch fields carry the worker.
          profile: "codex",
          provider: "codex",
          model: "codex-max",
        }),
        attempt(
          "migrate-cursor-pagination-export",
          "b410f767-1197-469b-8b89-af35338a4ed3",
          "completed",
          {
            ...fixtureLaunch(false),
            profile: "deepseek",
            resolved: {
              provider: "deepseek",
              model: "deepseek-v4-flash-turbo",
            },
          },
        ),
      ],
      summary: null,
      finishedAt: null,
      interruption: null,
    },
  };
};

Object.assign(extendedFixtureSymphonies, {
  workers: workersSymphony,
});

/**
 * A reported result that is one short paragraph (93 characters, no newline):
 * it clamps to a single visually truncated line at narrow panes, so Show more
 * must stay reachable at every width and reveal the complete text (finding
 * R1). One completed task keeps the completed symphony consistent.
 */
export const shortResultSummary =
  "Compared both pagination strategies, recorded the findings, and left the choice to the user.";

const shortResultSymphony = (): StoredSymphony => {
  const api = task("api", {
    worker: { role: "implementation", profile: "default" },
  });
  const base = storedSymphony();
  return {
    ...base,
    id: "f1151538-5302-4fbf-b50b-f6a55f2a5c25",
    status: "completed",
    revisions: [
      {
        number: 1,
        parent: null,
        reason: "Conductor task breakdown",
        acceptedAt: LOOP_T0,
        score: { tasks: [api] },
      },
    ],
    execution: {
      origin: "tracked",
      attempts: [
        {
          id: "b410f767-1197-469b-8b89-af35338a4ec9",
          taskId: "api",
          agentId: "worker-api",
          state: "completed",
          startedAt: LOOP_T0,
          endedAt: LOOP_T0 + 20 * LOOP_MINUTE,
          message: null,
          reportHash: "c".repeat(64),
          report: {
            outcome: "completed",
            summary: shortResultSummary,
            evidence: ["Read the recorded findings"],
            checks: [
              { name: "focused checks", status: "passed", detail: "green" },
            ],
          },
          launch: fixtureLaunch(true),
        },
      ],
      summary: shortResultSummary,
      finishedAt: LOOP_T0 + 30 * LOOP_MINUTE,
      interruption: null,
    },
  };
};

Object.assign(extendedFixtureSymphonies, {
  "short-result": shortResultSymphony,
});

/** Orchestrated symphonies record the goal as both plan and expected outcome. */
const goalEchoContext = {
  ...planContext,
  expectedOutcome: planContext.plan,
} satisfies SymphonyContext;

/** A list row: the stored symphony plus the concert's current project. */
interface PreviewSymphonyEntry {
  symphony: StoredSymphony;
  projectName: string;
}

/**
 * Interleaved project grouping: Northwind and Harbor alternate in list order,
 * and one Harbor concert shares its project's name, so its row must omit the
 * concert prefix while the other concerts keep theirs.
 */
const projectsFixtureSymphonies = (): PreviewSymphonyEntry[] => {
  const projectSymphony = (
    id: string,
    title: string,
    concertId: string,
    concertName: string,
  ): StoredSymphony => {
    const base = storedSymphony();
    return {
      ...base,
      id,
      title,
      source: { ...base.source, concertId, concertName },
    };
  };
  return [
    {
      symphony: projectSymphony(
        "f1151538-5302-4fbf-b50b-f6a55f2a5b51",
        "Export API audit",
        "ws-export-api",
        "export-api",
      ),
      projectName: "Northwind",
    },
    {
      symphony: projectSymphony(
        "f1151538-5302-4fbf-b50b-f6a55f2a5b52",
        "Harbor intake review",
        "ws-harbor",
        "Harbor",
      ),
      projectName: "Harbor",
    },
    {
      symphony: projectSymphony(
        "f1151538-5302-4fbf-b50b-f6a55f2a5b53",
        "Export UI audit",
        "ws-export-ui",
        "export-ui",
      ),
      projectName: "Northwind",
    },
    {
      symphony: projectSymphony(
        "f1151538-5302-4fbf-b50b-f6a55f2a5b54",
        "Storage research",
        "ws-storage",
        "storage-research",
      ),
      projectName: "Harbor",
    },
  ];
};

/** Fixtures that replace the whole list instead of the single symphony. */
const multiFixtureSymphonies: Record<string, () => PreviewSymphonyEntry[]> = {
  projects: projectsFixtureSymphonies,
};

export function usePreviewSymphonies(
  session: PodiumSession,
  failed: boolean,
  fixture: string | undefined = undefined,
) {
  const [entries, setEntries] = useState<PreviewSymphonyEntry[]>(() => {
    if (fixture) {
      const multi = multiFixtureSymphonies[fixture]?.();
      if (multi) {
        return multi;
      }
    }
    return [
      {
        symphony:
          (fixture ? fixtureSymphonyByName(fixture)?.() : undefined) ??
          storedSymphony(),
        projectName: "Northwind",
      },
    ];
  });
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const selectionId = state.symphonySelection?.id;
  const selected = entries.find((entry) => entry.symphony.id === selectionId);
  const data: SymphoniesData = {
    access: {
      available: true,
      commandPath: "/fixture/command.mjs",
      socketPath: "/fixture/commands.sock",
      message: null,
    },
    list: {
      symphonies: entries.map(({ symphony, projectName }) => ({
        ...summarizeSymphony(symphony),
        projectName,
      })),
      incomplete: false,
      unavailable: failed ? 1 : 0,
    },
    loading: false,
    stale: failed,
    detail: selected
      ? {
          symphony: selected.symphony,
          context: fixture === "goal-echo" ? goalEchoContext : planContext,
        }
      : undefined,
    detailStale: failed,
  };
  /** In-memory stand-in for the symphonies.delete RPC. */
  const remove = (stored: StoredSymphony): Promise<void> => {
    setEntries((prior) =>
      prior.filter((entry) => entry.symphony.id !== stored.id),
    );
    return Promise.resolve();
  };
  const progress = (kind: "claim" | "block" | "complete") =>
    setEntries((prior) => {
      const first = prior[0];
      if (!first) {
        return prior;
      }
      const symphony = structuredClone(first.symphony);
      symphony.version++;
      const tasks = symphony.revisions[0]?.score.tasks ?? [];
      if (kind === "claim") {
        symphony.status = "running";
        symphony.execution.attempts = [
          {
            id: "4101f767-1197-469b-8b89-af35338a4ed8",
            taskId: "api",
            agentId: "worker-api",
            state: "running",
            startedAt: Date.now(),
            endedAt: null,
            message: null,
            report: null,
            reportHash: null,
          },
        ];
      } else if (kind === "block") {
        symphony.status = "blocked";
        const attempt = symphony.execution.attempts[0];
        if (attempt) {
          attempt.state = "blocked";
          attempt.message =
            "Confirm the pagination compatibility requirement in the source conversation.";
        }
      } else {
        symphony.status = "completed";
        symphony.execution.finishedAt = Date.now();
        symphony.execution.summary =
          "Compared both implementations and recorded the pagination findings.";
        symphony.execution.attempts = tasks.map((task, index) => ({
          id: `4101f767-1197-469b-8b89-af35338a4ed${index}`,
          taskId: task.id,
          agentId: `worker-${task.id}`,
          state: "completed",
          startedAt: Date.now(),
          endedAt: Date.now(),
          message: null,
          reportHash: "c".repeat(64),
          report: {
            outcome: "completed",
            summary: `${task.title}: report delivered`,
            evidence: ["Reviewed the implementation and recorded the findings"],
            checks: [
              {
                name: "focused checks",
                status: "passed",
                detail: "All checks passed",
              },
            ],
          },
        }));
      }
      return prior.map((entry, index) =>
        index === 0 ? { ...entry, symphony } : entry,
      );
    });
  return { data, progress, remove };
}
