import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { commandServer } from "../server/entrypoints/commands/server";
import {
  agentCommand,
  assignmentPrompt,
  continuationPrompt,
  handoffInstructions,
  jsonCommand,
  nudgePrompt,
  unionChangedPaths,
} from "../server/symphonies/prompts";
import type { TaskReport } from "../shared/symphonies/models";
import { testDirectory } from "./fixtures";
import { fixtureSymphonyId } from "./symphony-fixtures";

void test("assigned command works without Conductor environment variables and safely quotes paths", async () => {
  const directory = join(await testDirectory(), "command's location");
  const server = await commandServer(directory, async (input) => ({
    acknowledged: input,
  }));
  assert.equal(server.access.available, true);
  try {
    const command = jsonCommand(
      agentCommand(server.access, "worker-1", "get"),
      { symphonyId: fixtureSymphonyId },
    );
    const result = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn("/bin/bash", ["-c", command], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout) as unknown, {
      acknowledged: {
        agentId: "worker-1",
        command: { kind: "get", symphonyId: fixtureSymphonyId },
      },
    });
    assert.equal(command.includes("$CONDUCTOR_COMMAND"), false);
  } finally {
    await server.close();
  }
});

void test("the assignment states what to do without payload samples or shell commands", () => {
  const prompt = assignmentPrompt({
    symphonyId: fixtureSymphonyId,
    attemptId: "attempt-1",
    taskId: "api",
    title: "Inspect the API",
    goal: "Inspect API and UI independently and combine findings",
    outcome: "Map the public endpoints",
    reads: ["src/api"],
    writes: [],
    checks: ["typecheck", "lint"],
    prerequisites: [
      { taskId: "prep", outcome: "completed", summary: "Found 3 endpoints" },
    ],
  });
  assert.match(prompt, /Task api: Inspect the API/);
  assert.match(prompt, /Goal: Inspect API and UI independently/);
  assert.match(prompt, /Assignment: Map the public endpoints/);
  assert.match(prompt, /Reads: src\/api/);
  assert.match(prompt, /Writes: none \(read-only\)/);
  assert.match(prompt, /Required checks: typecheck, lint/);
  assert.match(
    prompt,
    /Prerequisite results:\n- prep: completed\. Found 3 endpoints/,
  );
  assert.match(prompt, /up to 3 rounds/);
  assert.match(prompt, /Stop early if the same error/);
  assert.match(prompt, /Conductor `report` tool/);
  assert.match(prompt, /call `widen` before/);
  assert.match(prompt, /call `block`/);
  assert.match(prompt, /\[Conductor agent commands\]/);
  assert.match(prompt, /End your turn only after the report is accepted\./);
  assertNoPayloadSamples(prompt);
});

void test("a handoff renders the previous report and paths as lines", () => {
  const report: TaskReport = {
    outcome: "failed",
    summary: "Typecheck fails in the new RPC handler",
    evidence: ["npm run typecheck: TS2345 in server/rpc.ts:41"],
    checks: [
      { name: "typecheck", status: "failed", detail: "TS2345" },
      { name: "lint", status: "passed", detail: "Clean" },
    ],
    diagnosis: {
      tried: ["Narrowed the input type", "Regenerated the schema"],
      suspectedCause: "shared/schema.ts exports the old shape",
      need: "scope",
      requestedWrites: ["shared/schema.ts"],
    },
  };
  const handoff = handoffInstructions({
    attempt: { taskId: "api", number: 2, total: 3 },
    previousWorker: "pi/gpt-5",
    report,
    changedPaths: ["src/a.ts", "src/b.ts"],
    note: "Use the shared schema",
  });
  assert.match(handoff, /Attempt 2 of 3 for task api\./);
  assert.match(handoff, /\(pi\/gpt-5\)/);
  assert.match(handoff, /- src\/a\.ts\n- src\/b\.ts/);
  assert.match(handoff, /What it reported:/);
  assert.match(handoff, /- Result: Typecheck fails in the new RPC handler/);
  assert.match(handoff, /- Tried: Narrowed the input type/);
  assert.match(
    handoff,
    /- Suspected cause: shared\/schema\.ts exports the old shape/,
  );
  assert.match(handoff, /- Failing checks: typecheck: TS2345/);
  assert.match(handoff, /Conductor note: Use the shared schema/);
  assertNoPayloadSamples(handoff);
});

void test("a handoff covers missing paths, a worker block, and a server stop", () => {
  const missing = handoffInstructions({
    attempt: { taskId: "api", number: 1, total: 1 },
    previousWorker: "small",
  });
  assert.match(missing, /Changed files are unknown; review your write paths\./);
  assert.match(missing, /It stopped without reporting\./);

  const worker = handoffInstructions({
    attempt: { taskId: "api", number: 2, total: 2 },
    previousWorker: "small",
    blockedBy: "worker",
    blockMessage: "Need the user's decision on pagination.",
    changedPaths: ["src/api.ts"],
    changedPathsTruncated: true,
  });
  assert.match(
    worker,
    /It blocked with: `Need the user's decision on pagination\.`/,
  );
  assert.match(worker, /More paths changed than are listed/);
  assert.equal(worker.includes("It stopped without reporting."), false);

  // One unobservable earlier attempt makes the union advisory.
  const partial = handoffInstructions({
    attempt: { taskId: "api", number: 3, total: 3 },
    previousWorker: "small",
    changedPaths: ["src/api.ts"],
    changedPathsIncomplete: true,
  });
  assert.match(partial, /- src\/api\.ts/);
  assert.match(
    partial,
    /This list may be incomplete; review your write paths\./,
  );
  assert.equal(partial.includes("Changed files are unknown"), false);

  const server = handoffInstructions({
    attempt: { taskId: "api", number: 2, total: 2 },
    previousWorker: "small",
    blockedBy: "server",
    blockMessage: "Task agent stopped without a report after a nudge.",
  });
  assert.match(server, /It stopped without reporting\./);
  assert.equal(server.includes("It blocked with:"), false);
});

void test("continuation and nudge prompts are short and payload-free", () => {
  const continuation = continuationPrompt({
    taskId: "api",
    attemptId: "attempt-2",
    position: { taskId: "api", number: 2, total: 3 },
    note: "Widen the scope",
    writes: ["src", "shared"],
    added: ["shared"],
  });
  assert.match(
    continuation,
    /Continue task api, now attempt attempt-2 \(2 of 3\)\./,
  );
  assert.match(continuation, /Conductor note: Widen the scope/);
  assert.match(continuation, /Write paths now: src, shared \(added: shared\)/);
  assert.match(continuation, /Report or block this attempt when done\./);
  assertNoPayloadSamples(continuation);

  assert.equal(
    nudgePrompt("attempt-2"),
    "You ended your turn without reporting attempt attempt-2.\nCall `report` or `block` now.",
  );
  assertNoPayloadSamples(nudgePrompt("attempt-2"));
});

void test("a handoff path union sorts, dedupes, caps, and flags missing observations", () => {
  const union = unionChangedPaths([
    { changedPaths: ["src/b.ts", "src/a.ts"] },
    { changedPaths: ["src/a.ts", "src/c.ts"], changedPathsTruncated: true },
  ]);
  assert.deepEqual(union.paths, ["src/a.ts", "src/b.ts", "src/c.ts"]);
  assert.equal(union.truncated, true);
  assert.equal(union.observed, true);
  assert.equal(union.incomplete, false);
  // An unobservable earlier attempt marks the union incomplete.
  const partial = unionChangedPaths([{ changedPaths: ["src/a.ts"] }, {}]);
  assert.equal(partial.incomplete, true);
  assert.equal(partial.observed, true);
  // No observation at all is distinct from an observed empty list.
  const unknown = unionChangedPaths([{}, {}]);
  assert.equal(unknown.observed, false);
  assert.equal(unknown.incomplete, true);
  assert.equal(unknown.paths.length, 0);
  const observedEmpty = unionChangedPaths([{ changedPaths: [] }]);
  assert.equal(observedEmpty.observed, true);
  assert.equal(observedEmpty.incomplete, false);
});

/** A task-agent prompt never embeds a JSON payload sample or a shell command. */
function assertNoPayloadSamples(prompt: string): void {
  for (const forbidden of [
    "CONDUCTOR_JSON",
    "--socket",
    "--agent",
    "<<'",
    '"symphonyId"',
    '"attemptId"',
    '"evidence"',
    '"checks"',
    "node ",
  ]) {
    assert.equal(
      prompt.includes(forbidden),
      false,
      `task prompt must not contain ${forbidden}`,
    );
  }
}
