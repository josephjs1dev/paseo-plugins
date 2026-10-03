import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readCodexLimits, redeemCodexReset } from "./collectors/codex";
import type { createUsageReader } from "./usage";
import type { ResetAttempt, ResetOutcome } from "../shared/codex-reset";
import type { Usage } from "../shared/usage";

type ResetResult = { outcome: ResetOutcome; usage: Usage };
type Attempt = {
  request: ResetAttempt;
  started?: boolean;
  result?: Promise<ResetResult>;
};

export function createCodexResetter(
  reader: Pick<ReturnType<typeof createUsageReader>, "invalidate" | "read">,
  redeem = redeemCodexReset,
  readLimits = (signal: AbortSignal) =>
    readCodexLimits(signal, process.env.PASEO_USAGE_CODEX_BIN ?? "codex"),
) {
  const controller = new AbortController();
  const attempts = new Map<string, Attempt>();
  let activeKey: string | null = null;
  let preparation: Promise<ResetAttempt> | null = null;

  return {
    async prepare(): Promise<ResetAttempt> {
      if (controller.signal.aborted) {
        throw new Error("Reset service unavailable. Reopen provider usage.");
      }

      const active = activeKey ? attempts.get(activeKey) : undefined;

      if (active) {
        return active.request;
      }

      if (preparation) {
        return preparation;
      }

      preparation = (async () => {
        // Read fresh details once per attempt, before the client retains its key.
        const creditId = selectResetCredit(await readLimits(controller.signal));

        if (controller.signal.aborted) {
          throw new Error("Reset service unavailable. Reopen provider usage.");
        }

        // A retained request may have been retried while the read was pending.
        const active = activeKey ? attempts.get(activeKey) : undefined;

        if (active) {
          return active.request;
        }

        // Completed attempts are bounded; an unresolved attempt is never evicted.
        if (attempts.size >= 128) {
          const oldest = attempts.keys().next().value;

          if (oldest) {
            attempts.delete(oldest);
          }
        }

        activeKey = randomUUID();
        const request = { idempotencyKey: activeKey, creditId };
        attempts.set(activeKey, { request });

        return request;
      })()
        .catch(() => {
          throw new Error(
            "Could not prepare a reset. Check Codex sign-in and CLI support, then try again.",
          );
        })
        .finally(() => {
          preparation = null;
        });

      return preparation;
    },

    consume(request: ResetAttempt): Promise<ResetResult> {
      const { idempotencyKey } = request;
      let attempt = attempts.get(idempotencyKey);

      if (controller.signal.aborted) {
        return Promise.reject(
          new Error("Reset service unavailable. Reopen provider usage."),
        );
      }

      if (attempt && attempt.request.creditId !== request.creditId) {
        return Promise.reject(
          new Error("Retry the original reset without changing its credit."),
        );
      }

      if (attempt?.result) {
        return attempt.result;
      }

      if (
        activeKey &&
        activeKey !== idempotencyKey &&
        attempts.get(activeKey)?.started
      ) {
        return Promise.reject(
          new Error("Another reset is in progress. Try again shortly."),
        );
      }

      // Accept a client's retained UUID and credit after a plugin reload. Codex owns the
      // durable idempotency record; generating a replacement could spend twice.
      if (!attempt) {
        if (attempts.size >= 128) {
          const oldest = attempts.keys().next().value;

          if (oldest && oldest !== activeKey) {
            attempts.delete(oldest);
          }
        }

        attempt = { request: { ...request } };
        attempts.set(idempotencyKey, attempt);
      }

      activeKey = idempotencyKey;
      const currentAttempt = attempt;
      currentAttempt.started = true;

      attempt.result = (async () => {
        try {
          const { outcome } = await redeem(
            currentAttempt.request,
            controller.signal,
          );
          // Invalidate even for noCredit/nothingToReset: the old count may be stale.
          reader.invalidate("chatgpt");
          const usage = await reader.read("chatgpt");
          activeKey = null;

          return { outcome, usage };
        } catch {
          // Keep the key after an uncertain result so retrying cannot spend twice.
          delete currentAttempt.result;
          throw new Error(
            "Could not confirm the reset. Retry this request; it will not spend an additional credit. Check Codex sign-in and CLI support if this continues.",
          );
        }
      })();

      return attempt.result;
    },

    close() {
      controller.abort();
      attempts.clear();
      activeKey = null;
    },
  };
}

const timestampSchema = z.number().int().nonnegative().max(253_402_300_799);
const creditsSchema = z.object({
  rateLimitResetCredits: z
    .object({
      availableCount: z.number().int().nonnegative(),
      credits: z
        .array(
          z.object({
            id: z.string().min(1).max(1024),
            resetType: z.string().max(100),
            status: z.string().max(100),
            grantedAt: timestampSchema,
            expiresAt: timestampSchema.nullable(),
          }),
        )
        .max(1000)
        .nullish(),
    })
    .nullish(),
});

function selectResetCredit(input: unknown): string | undefined {
  const { rateLimitResetCredits } = creditsSchema.parse(input);

  if (!rateLimitResetCredits?.availableCount) {
    return undefined;
  }

  const now = Date.now() / 1000;
  const eligible = rateLimitResetCredits.credits?.filter(
    (credit) =>
      credit.status === "available" &&
      credit.resetType === "codexRateLimits" &&
      (credit.expiresAt === null || credit.expiresAt > now),
  );
  // Expiring credits precede permanent credits; ties use the oldest grant.
  eligible?.sort(
    (left, right) =>
      (left.expiresAt ?? Infinity) - (right.expiresAt ?? Infinity) ||
      left.grantedAt - right.grantedAt ||
      left.id.localeCompare(right.id),
  );

  return eligible?.[0]?.id;
}
