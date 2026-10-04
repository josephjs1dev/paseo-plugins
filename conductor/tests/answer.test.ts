import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { answer } from "../server/answer";
import { fileStore } from "../server/store";
import { requestKey } from "../server/identity";
import type { Decision } from "../shared/models";
import { agent, question, runtime, testDirectory } from "./fixtures";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";

const decision: Decision = {
  kind: "answers",
  answers: [{ selected: [0], text: "" }],
};
async function setup() {
  const directory = await testDirectory();
  const current = agent();
  const key = requestKey(current, question());
  return {
    directory,
    current,
    store: fileStore(directory),
    input: { key, agentId: current.id, requestId: question().id, decision },
  };
}
await test("normalized answers preserve native input and are delivered only once", async () => {
  const f = await setup();
  const delivered: AgentPermissionResponse[] = [];
  const host = runtime(() => f.current, {
    answer: async (_agent, _request, response) => {
      delivered.push(response);
    },
  });
  assert.deepEqual(await answer(host, f.store, f.input), {
    status: "answered",
  });
  assert.deepEqual(await answer(host, fileStore(f.directory), f.input), {
    status: "answered",
  });
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0], {
    behavior: "allow",
    updatedInput: { ...question().input, answers: { Pagination: "Cursor" } },
  });
  const disk = await readFile(
    join(f.directory, "receipts", `${f.input.key}.json`),
    "utf8",
  );
  assert.equal(disk.includes("Cursor"), false);
  assert.equal(disk.includes("pagination"), false);
});
await test("independent store instances cannot race into duplicate native responses", async () => {
  const f = await setup();
  let sends = 0;
  const host = runtime(() => f.current, {
    answer: async () => {
      sends++;
      await new Promise((resolve) => setTimeout(resolve, 15));
    },
  });
  const results = await Promise.all([
    answer(host, f.store, f.input),
    answer(host, fileStore(f.directory), f.input),
  ]);
  assert.equal(sends, 1);
  assert.equal(
    results.some((result) => result.status === "answered"),
    true,
  );
});
await test("lost response acknowledgment persists uncertainty across reload and prevents retry", async () => {
  const f = await setup();
  let sends = 0;
  const host = runtime(() => f.current, {
    answer: async () => {
      sends++;
      throw new Error("connection lost after acceptance");
    },
  });
  assert.deepEqual(await answer(host, f.store, f.input), { status: "unknown" });
  assert.deepEqual(await answer(host, fileStore(f.directory), f.input), {
    status: "unknown",
  });
  assert.equal(sends, 1);
});
await test("an interrupted durable claim cannot be replayed after restart", async () => {
  const f = await setup();
  await mkdir(join(f.directory, "receipts"));
  await writeFile(join(f.directory, "receipts", `${f.input.key}.json`), "{");
  let sends = 0;
  await assert.rejects(
    answer(
      runtime(() => f.current, {
        answer: async () => {
          sends++;
        },
      }),
      f.store,
      f.input,
    ),
  );
  assert.equal(sends, 0);
});
await test("changed questions, reused request IDs in a new session, and archived agents reject stale answers", async () => {
  for (const current of [
    agent({ pendingPermissions: [question({ title: "A different request" })] }),
    agent({ persistence: { provider: "codex", sessionId: "new-session" } }),
    agent({ archivedAt: new Date().toISOString() }),
    agent({ pendingPermissions: [] }),
  ]) {
    const f = await setup();
    let sends = 0;
    assert.deepEqual(
      await answer(
        runtime(() => current, {
          answer: async () => {
            sends++;
          },
        }),
        f.store,
        f.input,
      ),
      { status: "stale" },
    );
    assert.equal(sends, 0);
  }
});
await test("errored or closed workers, unsupported forms and invalid answers are not dispatched", async () => {
  for (const current of [
    agent({ status: "error" }),
    agent({ status: "closed" }),
    agent({ pendingPermissions: [question({ kind: "plan" })] }),
    agent({ pendingPermissions: [question({ input: { questions: [] } })] }),
  ]) {
    const f = await setup();
    const request = current.pendingPermissions[0];
    assert.ok(request);
    assert.deepEqual(
      await answer(
        runtime(() => current),
        f.store,
        { ...f.input, key: requestKey(current, request) },
      ),
      { status: "unsupported" },
    );
  }
  const f = await setup();
  assert.deepEqual(
    await answer(
      runtime(() => f.current),
      f.store,
      {
        ...f.input,
        decision: { kind: "answers", answers: [{ selected: [99], text: "" }] },
      },
    ),
    { status: "unsupported" },
  );
});
await test("native tool action IDs are validated server-side and retained in the response", async () => {
  const f = await setup();
  const request = question({
    kind: "tool",
    actions: [{ id: "one", label: "Allow this command", behavior: "allow" }],
  });
  const current = agent({ pendingPermissions: [request] });
  const responses: AgentPermissionResponse[] = [];
  const host = runtime(() => current, {
    answer: async (_agent, _request, response) => {
      responses.push(response);
    },
  });
  const input = {
    ...f.input,
    key: requestKey(current, request),
    decision: { kind: "action" as const, actionId: "invented" },
  };
  assert.deepEqual(await answer(host, f.store, input), {
    status: "unsupported",
  });
  assert.deepEqual(
    await answer(host, f.store, {
      ...input,
      decision: { kind: "action", actionId: "one" },
    }),
    { status: "answered" },
  );
  assert.deepEqual(responses, [{ behavior: "allow", selectedActionId: "one" }]);
});
await test("changing an answer under an existing receipt does not dispatch again", async () => {
  const f = await setup();
  await answer(
    runtime(() => f.current),
    f.store,
    f.input,
  );
  assert.deepEqual(
    await answer(
      runtime(() => f.current),
      f.store,
      {
        ...f.input,
        decision: {
          kind: "answers",
          answers: [{ selected: [], text: "Something else" }],
        },
      },
    ),
    { status: "unknown" },
  );
});
