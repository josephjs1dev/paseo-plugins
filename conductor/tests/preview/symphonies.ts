import { useState, useSyncExternalStore } from "react";
import type { PodiumSession } from "../../client/podium/session";
import type { SymphoniesData } from "../../client/symphonies/list";
import {
  summarizeSymphony,
  type StoredSymphony,
  type SymphonyContext,
} from "../../shared/symphonies/models";
import {
  fixtureSymphonies,
  planContext,
  recoverySymphony,
  storedSymphony,
} from "../symphony-fixtures";

/**
 * Preview-only fixture extensions kept out of the shared fixture record:
 * states the production fixtures do not carry a scenario for, so the browser
 * checks and screenshots can reach them through `?symphony-fixture=`.
 */
const extendedFixtureSymphonies: Record<string, () => StoredSymphony> = {
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
