import { useState, useSyncExternalStore } from "react";
import type { PodiumSession } from "../../client/podium/session";
import type { ConcertsData } from "../../client/concerts/list";
import {
  summarizeConcert,
  type StoredConcert,
} from "../../shared/concerts/models";
import {
  fixtureConcerts,
  planContext,
  recoveryConcert,
  storedConcert,
} from "../concert-fixtures";

/**
 * Preview-only fixture extensions kept out of the shared fixture record:
 * states the production fixtures do not carry a scenario for, so the browser
 * checks and screenshots can reach them through `?concert-fixture=`.
 */
const extendedFixtureConcerts: Record<string, () => StoredConcert> = {
  "agent-reuse": () => {
    const run = recoveryConcert();
    const attempt = run.execution?.attempts[0];
    if (!run.execution || !attempt) {
      return run;
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
      prompt: "Carry out the task and report evidence",
      settled: true,
    };
    run.execution.attempts.unshift(prior);
    return run;
  },
  "recovery-retry": () => {
    const run = recoveryConcert();
    const failed = run.execution?.attempts[0];
    if (!run.execution || !failed) {
      return run;
    }
    failed.endedAt = failed.startedAt + 5 * 60_000;
    // A later Conductor `addWrites` revision grows the task after the failed
    // attempt, so the history must not project it onto that attempt.
    const grown = structuredClone(run.revisions[0]);
    if (grown) {
      grown.number = 2;
      grown.parent = 1;
      grown.reason = "Conductor added write scope: shared/helper.ts";
      grown.acceptedAt = failed.endedAt + 60_000;
      grown.graph = {
        tasks: grown.graph.tasks.map((task) =>
          task.id === "repair"
            ? { ...task, writes: ["shared/helper.ts"] }
            : task,
        ),
      };
      run.revisions.push(grown);
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
      prompt: "Carry out the task and report evidence",
      settled: true,
    };
    run.execution.attempts.push(retry);
    run.status = "completed";
    return run;
  },
};

function fixtureConcertByName(
  fixture: string,
): (() => StoredConcert) | undefined {
  return extendedFixtureConcerts[fixture] ?? fixtureConcerts[fixture];
}

function managed(): StoredConcert {
  const base = storedConcert();
  return {
    ...base,
    status: "ready",
    draft: null,
    revisions: [
      {
        number: 1,
        parent: null,
        reason: "Source agent recorded the requested investigation",
        authority: "agent",
        acceptedAt: base.createdAt,
        graph: base.draft ?? { tasks: [] },
      },
    ],
    execution: {
      origin: "source-agent",
      attempts: [],
      summary: null,
      finishedAt: null,
      interruption: null,
    },
  };
}
export function usePreviewConcerts(
  session: PodiumSession,
  failed: boolean,
  legacy = false,
  fixture: string | undefined = undefined,
) {
  const [run, setConcert] = useState<StoredConcert | null>(
    () =>
      (fixture ? fixtureConcertByName(fixture)?.() : undefined) ??
      (legacy ? storedConcert() : managed()),
  );
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const data: ConcertsData = {
    access: {
      available: true,
      commandPath: "/fixture/command.mjs",
      socketPath: "/fixture/commands.sock",
      message: null,
    },
    list: {
      runs: run ? [summarizeConcert(run)] : [],
      incomplete: false,
      unavailable: failed ? 1 : 0,
    },
    loading: false,
    stale: failed,
    detail:
      run && state.concertSelection?.id === run.id
        ? { run, context: planContext }
        : undefined,
    detailStale: failed,
  };
  /** In-memory stand-in for the runs.delete RPC. */
  const remove = (stored: StoredConcert): Promise<void> => {
    setConcert((prior) => (prior && prior.id === stored.id ? null : prior));
    return Promise.resolve();
  };
  const progress = (kind: "claim" | "block" | "complete") =>
    setConcert((prior) => {
      if (!prior) {
        return prior;
      }
      const next = structuredClone(prior);
      if (!next.execution) {
        return next;
      }
      next.version++;
      const tasks = next.revisions[0]?.graph.tasks ?? [];
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
