import assert from "node:assert/strict";
import test from "node:test";
import type {
  RunAttempt,
  StoredRun,
  TaskDefinition,
  TaskReport,
} from "../shared/concerts/models";
import { taskState } from "../shared/concerts/task-state";
import { runId, storedRun, task } from "./run-fixtures";

const completedReport: TaskReport = {
  outcome: "completed",
  summary: "Findings collected.",
  evidence: ["Evidence with uncertainty notes"],
  checks: [],
};

function attempt(taskId: string, patch: Partial<RunAttempt> = {}): RunAttempt {
  return {
    id: runId,
    taskId,
    agentId: "agent-1",
    state: "completed",
    startedAt: 1791201600000,
    endedAt: 1791201600000,
    message: null,
    report: completedReport,
    reportHash: "c".repeat(64),
    ...patch,
  };
}

function launch(settled: boolean): NonNullable<RunAttempt["launch"]> {
  return {
    state: settled ? "started" : "uncertain",
    prompt: "Do the work",
    settled,
  };
}

function runWith(tasks: TaskDefinition[], attempts: RunAttempt[]): StoredRun {
  return {
    ...storedRun(),
    status: "running",
    draft: { tasks },
    execution: {
      origin: "orchestrator",
      attempts,
      summary: null,
      finishedAt: null,
      interruption: null,
    },
  };
}

void test("waiting lists prerequisites without a completed report or with an unsettled launch", () => {
  const api = task("api");
  const ui = task("ui");
  const collect = task("collect", { prerequisites: ["api", "ui"] });
  // api completed but its agent launch is still settling -> not done.
  const unsettledLaunch = runWith(
    [api, ui, collect],
    [
      attempt("api", { launch: launch(false) }),
      attempt("ui", { launch: launch(true) }),
    ],
  );
  assert.deepEqual(taskState(unsettledLaunch, collect), {
    key: "waiting",
    label: "Waiting",
    waitingFor: ["api"],
  });
  // ui has no attempt at all -> no completed report.
  const missingReport = runWith(
    [api, ui, collect],
    [attempt("api", { launch: launch(true) })],
  );
  assert.deepEqual(taskState(missingReport, collect), {
    key: "waiting",
    label: "Waiting",
    waitingFor: ["ui"],
  });
  // A prerequisite attempt that is not in a completed state also blocks.
  const stillRunning = runWith(
    [api, ui, collect],
    [
      attempt("api", { launch: launch(true) }),
      attempt("ui", {
        state: "running",
        endedAt: null,
        report: null,
        reportHash: null,
        launch: launch(false),
      }),
    ],
  );
  assert.deepEqual(taskState(stillRunning, collect), {
    key: "waiting",
    label: "Waiting",
    waitingFor: ["ui"],
  });
});

void test("a completed attempt with an unsettled launch reads as finishing", () => {
  const api = task("api");
  const run = runWith([api], [attempt("api", { launch: launch(false) })]);
  assert.deepEqual(taskState(run, api), {
    key: "finishing",
    label: "Finishing",
    waitingFor: [],
  });
});

void test("a completed attempt without launch metadata stays completed (legacy)", () => {
  const api = task("api");
  const legacy = runWith([api], [attempt("api")]);
  assert.deepEqual(taskState(legacy, api), {
    key: "completed",
    label: "Completed",
    waitingFor: [],
  });
  // A completed attempt with a settled launch is also completed.
  const settled = runWith([api], [attempt("api", { launch: launch(true) })]);
  assert.deepEqual(taskState(settled, api), {
    key: "completed",
    label: "Completed",
    waitingFor: [],
  });
});

void test("an explicit latest attempt running/blocked/failed state takes precedence", () => {
  const api = task("api");
  const collect = task("collect", { prerequisites: ["api"] });
  const apiDone = attempt("api", { launch: launch(true) });
  const active = (state: "running" | "blocked" | "failed") =>
    attempt("collect", {
      state,
      endedAt: null,
      report: null,
      reportHash: null,
      launch: launch(false),
    });
  const run = (state: "running" | "blocked" | "failed") =>
    runWith([api, collect], [apiDone, active(state)]);
  const labels = { running: "Running", blocked: "Blocked", failed: "Failed" };
  for (const state of ["running", "blocked", "failed"] as const) {
    assert.deepEqual(taskState(run(state), collect), {
      key: state,
      label: labels[state],
      waitingFor: [],
    });
  }
});

void test("no attempt with all prerequisites satisfied reads as ready", () => {
  const api = task("api");
  const ui = task("ui");
  const collect = task("collect", { prerequisites: ["api", "ui"] });
  const run = runWith(
    [api, ui, collect],
    [
      attempt("api", { launch: launch(true) }),
      attempt("ui", { launch: launch(true) }),
    ],
  );
  assert.deepEqual(taskState(run, collect), {
    key: "ready",
    label: "Ready",
    waitingFor: [],
  });
  // A leaf task with no prerequisites and no attempt starts ready.
  assert.deepEqual(taskState(runWith([api], []), api), {
    key: "ready",
    label: "Ready",
    waitingFor: [],
  });
});

void test("a failed latest attempt reads as failed even while its launch settles", () => {
  const api = task("api");
  const run = runWith(
    [api],
    [
      attempt("api", {
        state: "failed",
        report: {
          ...completedReport,
          outcome: "failed",
          summary: "Blocked on tooling.",
        },
        launch: launch(false),
      }),
    ],
  );
  assert.deepEqual(taskState(run, api), {
    key: "failed",
    label: "Failed",
    waitingFor: [],
  });
});
