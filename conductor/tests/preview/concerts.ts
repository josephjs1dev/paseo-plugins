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
  storedConcert,
} from "../concert-fixtures";

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
      (fixture ? fixtureConcerts[fixture]?.() : undefined) ??
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
