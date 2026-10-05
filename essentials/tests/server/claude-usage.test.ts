import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  claudeQuota,
  readClaudeLimits,
  readClaudeToken,
} from "../../server/collectors/claude";
import { normalizeClaude } from "../../shared/quota";
import { createUsageReader } from "../../server/usage";

test("Claude distinguishes sign-in problems from throttling and unknown failures", async () => {
  for (const [code, issue] of [
    ["claude-credentials", "sign-in"],
    ["claude-auth", "sign-in"],
    ["claude-scope", "sign-in"],
    ["claude-rate-limit", "rate-limit"],
    ["private-network-details", undefined],
  ] as const) {
    const reader = createUsageReader(async () => {
      throw new Error(code);
    });

    try {
      const usage = await reader.read("claude");
      assert.equal(usage.issue, issue);
      assert.equal(usage.status, "unavailable");
      assert.ok(!usage.message.includes("private-network-details"));
    } finally {
      reader.close();
    }
  }
});

test("Claude reads only the fixed usage endpoint with OAuth headers and rejects redirects", async () => {
  const request: typeof fetch = async (url, options) => {
    assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
    assert.equal(options?.redirect, "error");
    assert.deepEqual(options?.headers, {
      Authorization: "Bearer test-token",
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
    });

    return new Response(
      JSON.stringify({ five_hour: { utilization: 30, resets_at: null } }),
    );
  };

  const windows = normalizeClaude(
    await readClaudeLimits("test-token", new AbortController().signal, request),
  );
  assert.equal(windows[0]?.usedPercent, 30);
});

test("Claude rejects malformed and oversized responses and sanitizes HTTP errors", async () => {
  const signal = new AbortController().signal;

  for (const [status, code] of [
    [401, "claude-auth"],
    [403, "claude-scope"],
    [429, "claude-rate-limit"],
    [500, "claude-unavailable"],
  ] as const) {
    await assert.rejects(
      readClaudeLimits(
        "test",
        signal,
        async () => new Response("private-remote-body", { status }),
      ),
      { message: code },
    );
  }

  await assert.rejects(
    readClaudeLimits(
      "test",
      signal,
      async () => new Response("x".repeat(262_145)),
    ),
    /Response too large/,
  );
  await assert.rejects(
    readClaudeLimits("test", signal, async () => new Response("not json")),
    SyntaxError,
  );
  assert.ok(
    !claudeQuota
      .describeError(new Error("private-token"))
      .includes("private-token"),
  );
});

test("Claude cancels in-flight requests and never dispatches an already-cancelled request", async () => {
  const controller = new AbortController();
  const pending = readClaudeLimits(
    "test",
    controller.signal,
    async (_url, options) => {
      assert.ok(options?.signal);

      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => reject(new Error("cancelled")),
          { once: true },
        );
      });
    },
  );
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(
    readClaudeLimits("test", controller.signal, async () => {
      assert.fail("must not dispatch");
    }),
    /Cancelled/,
  );
});

test("Claude credentials honor explicit sources and never refresh or rewrite tokens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-claude-auth-"));
  const path = join(directory, ".credentials.json");
  const credentials = {
    claudeAiOauth: {
      accessToken: "test-file-token",
      expiresAt: 2000,
      scopes: ["user:profile"],
    },
  };
  const content = JSON.stringify(credentials);

  try {
    await writeFile(path, content);
    assert.equal(
      await readClaudeToken({ CLAUDE_CONFIG_DIR: directory }, 1000),
      "test-file-token",
    );
    assert.equal(
      await readClaudeToken({ CLAUDE_USAGE_AUTH_FILE: path }, 1000),
      "test-file-token",
    );
    assert.equal(
      await readClaudeToken({
        CLAUDE_CODE_OAUTH_TOKEN: "test-env-token",
        CLAUDE_USAGE_AUTH_FILE: "/nonexistent",
      }),
      "test-env-token",
    );
    await assert.rejects(
      readClaudeToken({ CLAUDE_USAGE_AUTH_FILE: path }, 2000),
      /claude-auth/,
    );
    assert.equal(await readFile(path, "utf8"), content);
    await writeFile(
      path,
      JSON.stringify({
        claudeAiOauth: {
          ...credentials.claudeAiOauth,
          scopes: ["user:inference"],
        },
      }),
    );
    await assert.rejects(
      readClaudeToken({ CLAUDE_USAGE_AUTH_FILE: path }, 1000),
      /claude-scope/,
    );

    for (const value of [
      "not-json",
      "x".repeat(65_537),
      JSON.stringify({ claudeAiOauth: { accessToken: "bad\ntoken" } }),
      "{}",
    ]) {
      await writeFile(path, value);
      await assert.rejects(
        readClaudeToken({ CLAUDE_USAGE_AUTH_FILE: path }),
        /claude-credentials/,
      );
    }

    await assert.rejects(
      readClaudeToken({ CLAUDE_USAGE_AUTH_FILE: join(directory, "missing") }),
      /claude-credentials/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude shares the usage cache and an empty response is unavailable", async () => {
  let calls = 0;
  let now = 0;
  const reader = createUsageReader(
    async () => {
      calls++;

      return {
        windows: normalizeClaude(
          calls === 1 ? { five_hour: { utilization: 100 } } : {},
        ),
      };
    },
    () => now,
  );

  try {
    const [first, second] = await Promise.all([
      reader.read("claude"),
      reader.read("claude"),
    ]);
    assert.deepEqual(first, second);
    assert.equal(first.status, "ok");
    assert.equal(calls, 1);
    now = 60_001;
    assert.equal((await reader.read("claude")).status, "unavailable");
  } finally {
    reader.close();
  }
});
