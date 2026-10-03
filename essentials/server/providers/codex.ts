import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  normalizeCodex,
  normalizeCodexCredits,
  normalizeCodexResetCredits,
} from "../../shared/quota";
import {
  resetAttemptSchema,
  resetResponseSchema,
  type ResetAttempt,
} from "../../shared/codex-reset";
import { collectCodex } from "../history-sources";
import type { ProviderAdapter } from "./types";

export const codexAdapter: ProviderAdapter = {
  async readQuota(signal) {
    const binary = process.env.PASEO_USAGE_CODEX_BIN ?? "codex";
    const response = await readCodexLimits(signal, binary);

    return {
      windows: normalizeCodex(response),
      credits: normalizeCodexCredits(response),
      resetCredits: normalizeCodexResetCredits(response),
    };
  },

  readHistory(since, signal, modifiedSince) {
    const root = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const directories = [
      join(root, "sessions"),
      join(root, "archived_sessions"),
    ];

    return collectCodex(
      directories,
      since,
      signal,
      modifiedSince === undefined ? undefined : { modifiedSince },
    );
  },

  describeError() {
    return "Codex limits unavailable. Check the Codex CLI and ChatGPT sign-in on this host.";
  },
};

// No thread or turn is started. The CLI owns authentication and token refresh.
export function readCodexLimits(
  signal: AbortSignal,
  binary = "codex",
): Promise<unknown> {
  return requestCodexAccount(signal, binary, {
    method: "account/rateLimits/read",
  });
}

export async function redeemCodexReset(
  attempt: ResetAttempt,
  signal: AbortSignal,
  binary = process.env.PASEO_USAGE_CODEX_BIN ?? "codex",
) {
  const params = resetAttemptSchema.parse(attempt);
  const result = await requestCodexAccount(signal, binary, {
    method: "account/rateLimitResetCredit/consume",
    params,
  });

  return resetResponseSchema.parse(result);
}

function requestCodexAccount(
  signal: AbortSignal,
  binary: string,
  request: {
    method: "account/rateLimits/read" | "account/rateLimitResetCredit/consume";
    params?: ResetAttempt;
  },
): Promise<unknown> {
  if (signal.aborted) {
    return Promise.reject(new Error("Cancelled"));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["app-server"], {
      stdio: ["pipe", "pipe", "ignore"],
      shell: false,
    });
    let buffer = "";
    let bytes = 0;
    let done = false;
    const timeout = setTimeout(
      () => finish(new Error("Codex timed out")),
      12_000,
    );
    const abort = () => finish(new Error("Cancelled"));
    function finish(error: Error | null, value?: unknown) {
      if (done) {
        return;
      }

      done = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      child.stdin.destroy();
      child.stdout.destroy();
      child.kill();
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
      killTimer.unref();
      child.once("close", () => clearTimeout(killTimer));

      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    }

    const send = (message: unknown) =>
      child.stdin.write(`${JSON.stringify(message)}\n`);
    child.once("error", () => finish(new Error("Codex could not start")));
    child.stdin.on("error", () => finish(new Error("Codex connection closed")));
    child.once("close", () =>
      finish(new Error("Codex closed before responding")),
    );
    signal.addEventListener("abort", abort, { once: true });

    if (signal.aborted) {
      abort();

      return;
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (done) {
        return;
      }

      bytes += Buffer.byteLength(chunk);

      if (bytes > 1_048_576) {
        finish(new Error("Codex response too large"));

        return;
      }

      buffer += chunk;
      let newline: number;
      while (!done && (newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);

        try {
          const message: unknown = JSON.parse(line);

          if (!message || typeof message !== "object" || !("id" in message)) {
            continue;
          }

          if ((message.id === 0 || message.id === 1) && "error" in message) {
            finish(new Error("Codex rejected the account request"));

            return;
          }

          if (message.id === 0 && "result" in message) {
            send({ method: "initialized", params: {} });
            send({ id: 1, ...request });
          } else if (message.id === 1 && "result" in message) {
            finish(null, message.result);
          }
        } catch {
          finish(new Error("Invalid Codex response"));
        }
      }
    });
    send({
      id: 0,
      method: "initialize",
      params: { clientInfo: { name: "nestkit_usage", version: "0.1.0" } },
    });
  });
}
