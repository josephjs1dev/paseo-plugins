import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { commandServer } from "../server/entrypoints/commands/server";
import {
  agentCommand,
  jsonCommand,
  reportInstructions,
  retryInstructions,
  workerInstructions,
} from "../server/symphonies/prompts";
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
    const prompt = reportInstructions(
      (agent, verb) => agentCommand(server.access, agent, verb),
      "worker-1",
      fixtureSymphonyId,
      fixtureSymphonyId,
      ["Verify result"],
    );
    assert.ok(prompt.includes("<<'CONDUCTOR_JSON'"));
    assert.ok(prompt.includes("empty output is NOT acknowledgement"));
    assert.match(prompt, /Prefer the Paseo Conductor report MCP tool/);
    assert.match(prompt, /Paseo Conductor get MCP tool/);
    assert.match(prompt, /Paseo Conductor block MCP tool/);
    assert.ok(
      prompt.indexOf("Conductor report MCP tool") <
        prompt.indexOf("<<'CONDUCTOR_JSON'"),
    );
    assert.equal(prompt.includes("$CONDUCTOR_COMMAND"), false);
  } finally {
    await server.close();
  }
});

void test("task agent instructions are fix-first, widen, and report", () => {
  const access = {
    available: true,
    commandPath: "/tmp/command path.mjs",
    socketPath: "/tmp/conductor.sock",
    message: null,
  };
  const prompt = workerInstructions(
    (agent, verb) => agentCommand(access, agent, verb),
    "worker-1",
    fixtureSymphonyId,
    fixtureSymphonyId,
    ["typecheck"],
  );
  assert.match(prompt, /If a required check fails/);
  assert.match(prompt, /up to 3 fix rounds/);
  assert.match(prompt, /two rounds in a row end with the same error/);
  assert.match(prompt, /Report breakage that existed before your change/);
  assert.match(prompt, /widen/);
  assert.match(prompt, /Conductor widen MCP tool/);
  assert.match(prompt, /<<'CONDUCTOR_JSON'/);
  assert.match(prompt, /diagnosis/);
  assert.match(prompt, /--agent 'worker-1' --socket/);
  assert.equal(prompt.includes("$CONDUCTOR_COMMAND"), false);
});

void test("retry instructions keep the note and only copy the report to a new agent", () => {
  const report = {
    outcome: "failed" as const,
    summary: "Typecheck fails in the new RPC handler",
    evidence: ["npm run typecheck: TS2345 in server/rpc.ts:41"],
    checks: [
      { name: "typecheck", status: "failed" as const, detail: "TS2345" },
    ],
    diagnosis: {
      tried: ["Narrowed the input type", "Regenerated the schema"],
      suspectedCause: "shared/schema.ts exports the old shape",
      need: "scope" as const,
      requestedWrites: ["shared/schema.ts"],
    },
  };
  const continuation = retryInstructions(
    { report, note: "Use the shared schema" },
    true,
  );
  assert.match(continuation, /Use the shared schema/);
  assert.equal(continuation.includes("Typecheck fails"), false);
  const fresh = retryInstructions(
    { report, note: "Use the shared schema" },
    false,
  );
  assert.match(fresh, /previous attempt failed/i);
  assert.match(fresh, /shared\/schema\.ts exports the old shape/);
  assert.match(fresh, /requestedWrites/);
  const truncated = retryInstructions(
    { report: { ...report, summary: "x".repeat(5000) } },
    false,
  );
  assert.ok(truncated.length < 4000);
});
