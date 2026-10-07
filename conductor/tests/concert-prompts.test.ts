import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { commandServer } from "../server/concerts/commands/server";
import {
  agentCommand,
  jsonCommand,
  reportInstructions,
} from "../server/concerts/prompts";
import { testDirectory } from "./fixtures";
import { fixtureConcertId } from "./concert-fixtures";

void test("assigned command works without Conductor environment variables and safely quotes paths", async () => {
  const directory = join(await testDirectory(), "command's location");
  const server = await commandServer(directory, async (input) => ({
    acknowledged: input,
  }));
  assert.equal(server.access.available, true);
  try {
    const command = jsonCommand(
      agentCommand(server.access, "worker-1", "get"),
      { concertId: fixtureConcertId },
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
        command: { kind: "get", concertId: fixtureConcertId },
      },
    });
    const prompt = reportInstructions(
      (agent, verb) => agentCommand(server.access, agent, verb),
      "worker-1",
      fixtureConcertId,
      fixtureConcertId,
      ["Verify result"],
    );
    assert.ok(prompt.includes("<<'CONDUCTOR_JSON'"));
    assert.ok(prompt.includes("empty output is NOT acknowledgement"));
    assert.equal(prompt.includes("$CONDUCTOR_COMMAND"), false);
  } finally {
    await server.close();
  }
});
