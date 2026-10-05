import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { normalizeClaude } from "../../shared/quota";
import { createClaudeHistoryParser } from "../../shared/history-parsers";
import { collectJsonl } from "../history-sources";
import type { QuotaCapability, UsageCollector } from "./types";

const errorMessages: Record<string, string> = {
  "claude-credentials":
    "Claude login unavailable. Sign in to Claude Code on this host, or configure CLAUDE_USAGE_AUTH_FILE or CLAUDE_CODE_OAUTH_TOKEN for the daemon.",
  "claude-auth":
    "Claude login expired or was rejected. Sign in to Claude Code again on this host.",
  "claude-scope":
    "Claude usage requires a subscription login with user:profile access. Sign in to Claude Code on this host.",
  "claude-rate-limit":
    "Claude's usage endpoint is rate limited. Try again in a few minutes.",
};

export const claudeQuota: QuotaCapability = {
  provider: "claude",
  async read(signal) {
    if (signal.aborted) {
      throw new Error("Cancelled");
    }

    const token = await readClaudeToken();

    return { windows: normalizeClaude(await readClaudeLimits(token, signal)) };
  },
  describeError(error) {
    const code = error instanceof Error ? error.message : "";

    return (
      errorMessages[code] ?? "Claude usage unavailable. Try again shortly."
    );
  },
  describeIssue(error) {
    const code = error instanceof Error ? error.message : "";

    if (["claude-credentials", "claude-auth", "claude-scope"].includes(code)) {
      return "sign-in";
    }

    return code === "claude-rate-limit" ? "rate-limit" : undefined;
  },
};

/** Fixed OAuth endpoint; redirects must never forward the subscription token. */
export async function readClaudeLimits(
  token: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<unknown> {
  if (signal.aborted) {
    throw new Error("Cancelled");
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 12_000);

  try {
    return await fetchClaudeLimits(token, controller.signal, request);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

async function fetchClaudeLimits(
  token: string,
  signal: AbortSignal,
  request: typeof fetch,
): Promise<unknown> {
  const response = await request("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${claudeTokenSchema.parse(token)}`,
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
    },
    redirect: "error",
    signal,
  });

  if (!response.ok) {
    await response.body?.cancel();
    const errors: Record<number, string> = {
      401: "claude-auth",
      403: "claude-scope",
      429: "claude-rate-limit",
    };
    throw new Error(errors[response.status] ?? "claude-unavailable");
  }

  if (!response.body) {
    throw new Error("Empty response");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      size += value.byteLength;

      if (size > 262_144) {
        throw new Error("Response too large");
      }

      chunks.push(value);
    }

    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    await reader.cancel();
  }
}

export const claudeCollector: UsageCollector = {
  harness: "claude",
  providers: ["claude"],
  quota: claudeQuota,
  collectHistory({ since, signal, modifiedSince }) {
    return collectClaude(since, signal, undefined, modifiedSince);
  },
};

export function claudeHistoryDirectory(env = process.env): string {
  return (
    env.CLAUDE_USAGE_PROJECTS_DIR ??
    join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects")
  );
}

function sessionFileGroup(path: string): string {
  const directory = dirname(path);

  if (basename(directory) === "subagents") {
    return dirname(directory);
  }

  return join(directory, basename(path).replace(/\.jsonl(?:\.zst)?$/, ""));
}

export function collectClaude(
  since: number,
  signal: AbortSignal,
  roots = [claudeHistoryDirectory()],
  modifiedSince?: number,
) {
  return collectJsonl(
    roots,
    since,
    signal,
    createClaudeHistoryParser,
    modifiedSince,
    sessionFileGroup,
  );
}

const claudeTokenSchema = z.string().min(1).max(8192).regex(/^\S+$/);
const credentialsSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: claudeTokenSchema,
    expiresAt: z.number().finite().nonnegative().optional(),
    scopes: z.array(z.string().max(100)).max(100).optional(),
  }),
});

/** Read-only: Claude Code owns token refresh and credential persistence. */
export async function readClaudeToken(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): Promise<string> {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    return claudeTokenSchema.parse(env.CLAUDE_CODE_OAUTH_TOKEN);
  }

  const path =
    env.CLAUDE_USAGE_AUTH_FILE ??
    join(
      env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
      ".credentials.json",
    );
  let content: string;

  try {
    const file = await open(path, "r");

    try {
      const buffer = Buffer.alloc(65_537);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);

      if (bytesRead > 65_536) {
        throw new Error("Credentials too large");
      }

      content = buffer.toString("utf8", 0, bytesRead);
    } finally {
      await file.close();
    }
  } catch {
    throw new Error("claude-credentials");
  }

  const parsed = credentialsSchema.safeParse(parseJson(content));

  if (!parsed.success) {
    throw new Error("claude-credentials");
  }

  const credentials = parsed.data.claudeAiOauth;

  if (credentials.expiresAt !== undefined && credentials.expiresAt <= now) {
    throw new Error("claude-auth");
  }

  if (credentials.scopes && !credentials.scopes.includes("user:profile")) {
    throw new Error("claude-scope");
  }

  return credentials.accessToken;
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new Error("claude-credentials");
  }
}
