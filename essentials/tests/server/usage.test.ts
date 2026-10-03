import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readCodexLimits } from "../../server/collectors/codex";
import { normalizeCodex, normalizeGo } from "../../shared/quota";
import { readGoLimits } from "../../server/collectors/opencode";
import { createUsageReader } from "../../server/usage";
import { usageLabel } from "../../shared/usage";

const codexWindow = {
  usedPercent: 25,
  windowDurationMins: 300,
  resetsAt: 1_800_000_000,
};
const goWindow = {
  status: "ok",
  percent: 42,
  resetsAt: "2027-01-15T08:00:00Z",
};

test("Go uses only the fixed HTTPS endpoint and rejects redirects", async () => {
  const request: typeof fetch = async (url, options) => {
    assert.equal(url, "https://opencode.ai/zen/go/v1/usage");
    assert.equal(options?.redirect, "error");
    assert.deepEqual(options?.headers, { Authorization: "Bearer test-key" });

    return new Response(
      JSON.stringify({
        usage: { rolling: goWindow, weekly: goWindow, monthly: goWindow },
      }),
    );
  };

  assert.equal(
    normalizeGo(
      await readGoLimits("test-key", new AbortController().signal, request),
    ).length,
    3,
  );
});

test("Go bounds response size and drops remote error bodies", async () => {
  const signal = new AbortController().signal;
  await assert.rejects(
    readGoLimits(
      "test-key",
      signal,
      async () => new Response("private remote details", { status: 401 }),
    ),
    /^Error: go-auth$/,
  );
  await assert.rejects(
    readGoLimits(
      "test-key",
      signal,
      async () => new Response("x".repeat(262_145)),
    ),
    /Response too large/,
  );
  await assert.rejects(
    readGoLimits("test-key", signal, async () => new Response("not json")),
    SyntaxError,
  );
});

test("Go forwards cancellation to the request", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    readGoLimits("test-key", controller.signal, async (_url, options) => {
      assert.equal(options?.signal?.aborted, true);
      throw new Error("aborted");
    }),
    /aborted/,
  );
});

test("usage cache deduplicates requests and retries failures after one minute", async () => {
  let clock = 0;
  let calls = 0;
  const reader = createUsageReader(
    async () => {
      calls++;
      throw new Error("secret-token-must-not-escape");
    },
    () => clock,
  );
  const [first, second] = await Promise.all([
    reader.read("chatgpt"),
    reader.read("chatgpt"),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  assert.equal(first.status, "unavailable");
  assert.equal(JSON.stringify(first).includes("secret-token"), false);
  assert.equal(usageLabel(first), "ChatGPT · —");
  clock = 60_001;
  await reader.read("chatgpt");
  assert.equal(calls, 2);
  reader.close();
});

test("plugin cleanup cancels in-flight provider work", async () => {
  const reader = createUsageReader(
    async (_provider, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        });
      }),
  );
  const pending = reader.read("chatgpt");
  reader.close();
  assert.equal((await pending).status, "unavailable");
});

test("credit-only Codex accounts return their balance and share the quota cache", async () => {
  let calls = 0;
  const credits = { hasCredits: true, unlimited: false, balance: 2500.5 };
  const reader = createUsageReader(async () => {
    calls++;

    return { windows: [], credits };
  });

  try {
    const usage = await reader.read("chatgpt");
    assert.equal(usage.status, "ok");
    assert.deepEqual(usage.credits, credits);
    assert.deepEqual(await reader.read("chatgpt"), usage);
    assert.equal(calls, 1);
  } finally {
    reader.close();
  }
});

test("Codex handshakes and reads limits without starting an agent turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nestkit-usage-test-"));
  const binary = join(directory, "fake-codex");

  try {
    await writeFile(
      binary,
      `#!${process.execPath}\nconst readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let initialized = false;
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') console.log(JSON.stringify({ id: m.id, result: {} }));
  else if (m.method === 'initialized') initialized = true;
  else if (m.method === 'account/rateLimits/read' && initialized) console.log(JSON.stringify({ id: m.id, result: { rateLimits: { primary: ${JSON.stringify(codexWindow)} } } }));
  else process.exit(1);
});\n`,
      { mode: 0o700 },
    );
    const result = await readCodexLimits(new AbortController().signal, binary);
    assert.equal(normalizeCodex(result)[0]?.usedPercent, 25);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      readCodexLimits(controller.signal, binary),
      /Cancelled/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
