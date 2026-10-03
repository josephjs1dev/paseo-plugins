import { open } from "node:fs/promises";
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeGo } from "../../shared/quota";
import { collectOpenCode } from "../history-sources";
import type { UsageCollector } from "./types";

const errorMessages: Record<string, string> = {
  "go-key":
    "Sign in to OpenCode Go on this host, or set OPENCODE_GO_API_KEY for the Paseo daemon.",
  "go-auth":
    "OpenCode Go rejected the API key. Reconnect your Go account on this host.",
  "go-subscription":
    "This key does not have an active OpenCode Go subscription.",
};

export const opencodeCollector: UsageCollector = {
  harness: "opencode",
  providers: ["opencode-go"],
  async collectHistory({ since, signal, modifiedSince }) {
    const dataHome =
      process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
    const database =
      process.env.OPENCODE_USAGE_DB ??
      join(dataHome, "opencode", "opencode.db");

    try {
      return await collectOpenCode(database, since, signal, modifiedSince);
    } catch {
      if (signal.aborted) {
        throw new Error("Cancelled");
      }

      // An unfinished database snapshot must not replace a cached session day.
      return { rows: [], incomplete: true };
    }
  },
  quota: {
    provider: "opencode-go",
    async read(signal) {
      let key: string;

      try {
        key = await readGoKey();
      } catch {
        throw new Error("go-key");
      }

      return { windows: normalizeGo(await readGoLimits(key, signal)) };
    },
    describeError(error) {
      const code = error instanceof Error ? error.message : "";

      return (
        errorMessages[code] ??
        "OpenCode Go usage unavailable. Try again shortly."
      );
    },
  },
};

const keySchema = z.string().min(1).max(8192).regex(/^\S+$/);
const authSchema = z.object({
  "opencode-go": z.object({ type: z.literal("api"), key: keySchema }),
});

const responseErrors: Record<number, string> = {
  401: "go-auth",
  403: "go-subscription",
};

async function readGoKey(): Promise<string> {
  if (process.env.OPENCODE_GO_API_KEY) {
    return keySchema.parse(process.env.OPENCODE_GO_API_KEY);
  }

  const path =
    process.env.OPENCODE_GO_AUTH_FILE ??
    join(
      process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
      "opencode",
      "auth.json",
    );
  const file = await open(path, "r");

  try {
    const buffer = Buffer.alloc(65_537);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);

    if (bytesRead > 65_536) {
      throw new Error("Auth file too large");
    }

    return authSchema.parse(JSON.parse(buffer.toString("utf8", 0, bytesRead)))[
      "opencode-go"
    ].key;
  } finally {
    await file.close();
  }
}

export async function readGoLimits(
  key: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });

  if (signal.aborted) {
    controller.abort();
  }

  const timer = setTimeout(abort, 12_000);

  try {
    const response = await request("https://opencode.ai/zen/go/v1/usage", {
      headers: { Authorization: `Bearer ${keySchema.parse(key)}` },
      redirect: "error",
      signal: controller.signal,
    });

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(responseErrors[response.status] ?? "go-unavailable");
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
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
