import assert from "node:assert/strict";
import test from "node:test";
import type {
  Attempt,
  StoredSymphony,
  TaskDefinition,
  TaskReport,
} from "../shared/symphonies/models";
import { taskState } from "../shared/symphonies/task-state";
import { fixtureSymphonyId, storedSymphony, task } from "./symphony-fixtures";

const completedReport: TaskReport = {
  outcome: "completed",
  summary: "Findings collected.",
  evidence: ["Evidence with uncertainty notes"],
  checks: [],
};

function attempt(taskId: string, patch: Partial<Attempt> = {}): Attempt {
  return {
    id: fixtureSymphonyId,
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

function launch(settled: boolean): NonNullable<Attempt["launch"]> {
  return {
    state: settled ? "started" : "uncertain",
    profile: "inherit",
    generation: 0,
    prompt: "Do the work",
    settled,
  };
}

function symphonyWith(
  tasks: TaskDefinition[],
  attempts: Attempt[],
): StoredSymphony {
  return {
    ...storedSymphony(),
    status: "running",
    execution: {
      origin: "conducted",
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
  const unsettledLaunch = symphonyWith(
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
  const missingReport = symphonyWith(
    [api, ui, collect],
    [attempt("api", { launch: launch(true) })],
  );
  assert.deepEqual(taskState(missingReport, collect), {
    key: "waiting",
    label: "Waiting",
    waitingFor: ["ui"],
  });
  // A prerequisite attempt that is not in a completed state also blocks.
  const stillRunning = symphonyWith(
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
  const symphony = symphonyWith(
    [api],
    [attempt("api", { launch: launch(false) })],
  );
  assert.deepEqual(taskState(symphony, api), {
    key: "finishing",
    label: "Finishing",
    waitingFor: [],
  });
});

void test("a completed attempt without launch metadata stays completed", () => {
  const api = task("api");
  const plain = symphonyWith([api], [attempt("api")]);
  assert.deepEqual(taskState(plain, api), {
    key: "completed",
    label: "Completed",
    waitingFor: [],
  });
  // A completed attempt with a settled launch is also completed.
  const settled = symphonyWith(
    [api],
    [attempt("api", { launch: launch(true) })],
  );
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
  const symphonyFor = (state: "running" | "blocked" | "failed") =>
    symphonyWith([api, collect], [apiDone, active(state)]);
  const labels = { running: "Running", blocked: "Blocked", failed: "Failed" };
  for (const state of ["running", "blocked", "failed"] as const) {
    assert.deepEqual(taskState(symphonyFor(state), collect), {
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
  const symphony = symphonyWith(
    [api, ui, collect],
    [
      attempt("api", { launch: launch(true) }),
      attempt("ui", { launch: launch(true) }),
    ],
  );
  assert.deepEqual(taskState(symphony, collect), {
    key: "ready",
    label: "Ready",
    waitingFor: [],
  });
  // A leaf task with no prerequisites and no attempt starts ready.
  assert.deepEqual(taskState(symphonyWith([api], []), api), {
    key: "ready",
    label: "Ready",
    waitingFor: [],
  });
});

void test("a failed latest attempt reads as failed even while its launch settles", () => {
  const api = task("api");
  const symphony = symphonyWith(
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
  assert.deepEqual(taskState(symphony, api), {
    key: "failed",
    label: "Failed",
    waitingFor: [],
  });
});

void test("several attempts sharing one agent derive state from the latest attempt", () => {
  const api = task("api");
  const first = attempt("api", {
    id: "b410f767-1197-469b-8b89-af35338a4e11",
    agentId: "agent-1",
    state: "failed",
    report: {
      ...completedReport,
      outcome: "failed",
      summary: "First attempt failed.",
    },
    reportHash: "d".repeat(64),
    launch: launch(true),
  });
  const active = attempt("api", {
    id: "b410f767-1197-469b-8b89-af35338a4e12",
    agentId: "agent-1",
    state: "running",
    endedAt: null,
    report: null,
    reportHash: null,
    launch: launch(false),
  });
  assert.deepEqual(taskState(symphonyWith([api], [first, active]), api), {
    key: "running",
    label: "Running",
    waitingFor: [],
  });
  const failedAgain = attempt("api", {
    id: "b410f767-1197-469b-8b89-af35338a4e13",
    agentId: "agent-1",
    state: "failed",
    report: {
      ...completedReport,
      outcome: "failed",
      summary: "Second attempt failed.",
    },
    reportHash: "e".repeat(64),
    launch: launch(false),
  });
  assert.deepEqual(
    taskState(symphonyWith([api], [first, active, failedAgain]), api),
    { key: "failed", label: "Failed", waitingFor: [] },
  );
});
