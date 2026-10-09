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
    // A later Conductor `addWrites` revision grows the task after the failed
    // attempt, so the history must not project it onto that attempt.
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
    // The fresh successful retry on another agent: the task card carries no
    // grant, so the history is the only place the earlier reason survives.
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

export function usePreviewSymphonies(
  session: PodiumSession,
  failed: boolean,
  fixture: string | undefined = undefined,
) {
  const [symphony, setSymphony] = useState<StoredSymphony | null>(
    () =>
      (fixture ? fixtureSymphonyByName(fixture)?.() : undefined) ??
      storedSymphony(),
  );
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const data: SymphoniesData = {
    access: {
      available: true,
      commandPath: "/fixture/command.mjs",
      socketPath: "/fixture/commands.sock",
      message: null,
    },
    list: {
      symphonies: symphony
        ? [{ ...summarizeSymphony(symphony), projectName: "Northwind" }]
        : [],
      incomplete: false,
      unavailable: failed ? 1 : 0,
    },
    loading: false,
    stale: failed,
    detail:
      symphony && state.symphonySelection?.id === symphony.id
        ? {
            symphony,
            context: fixture === "goal-echo" ? goalEchoContext : planContext,
          }
        : undefined,
    detailStale: failed,
  };
  /** In-memory stand-in for the symphonies.delete RPC. */
  const remove = (stored: StoredSymphony): Promise<void> => {
    setSymphony((prior) => (prior && prior.id === stored.id ? null : prior));
    return Promise.resolve();
  };
  const progress = (kind: "claim" | "block" | "complete") =>
    setSymphony((prior) => {
      if (!prior) {
        return prior;
      }
      const next = structuredClone(prior);
      next.version++;
      const tasks = next.revisions[0]?.score.tasks ?? [];
      if (kind === "claim") {
        next.status = "running";
        next.execution.attempts = [
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
        next.status = "blocked";
        const attempt = next.execution.attempts[0];
        if (attempt) {
          attempt.state = "blocked";
          attempt.message =
            "Confirm the pagination compatibility requirement in the source conversation.";
        }
      } else {
        next.status = "completed";
        next.execution.finishedAt = Date.now();
        next.execution.summary =
          "Compared both implementations and recorded the pagination findings.";
        next.execution.attempts = tasks.map((task, index) => ({
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
      return next;
    });
  return { data, progress, remove };
}
