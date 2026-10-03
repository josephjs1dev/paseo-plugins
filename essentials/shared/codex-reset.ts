import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { usageSchema } from "./usage";

export const resetAttemptSchema = z.object({
  idempotencyKey: z.string().uuid(),
  creditId: z.string().min(1).max(1024).optional(),
});
export type ResetAttempt = z.infer<typeof resetAttemptSchema>;
export const resetOutcomeSchema = z.enum([
  "reset",
  "alreadyRedeemed",
  "nothingToReset",
  "noCredit",
]);
export const resetResponseSchema = z.object({ outcome: resetOutcomeSchema });
export type ResetOutcome = z.infer<typeof resetOutcomeSchema>;

// Preparing an attempt never spends a credit.
export const prepareCodexReset = defineRpc({
  name: "usage.codex-reset.prepare",
  input: z.object({}),
  output: resetAttemptSchema,
});

export const consumeCodexReset = defineRpc({
  name: "usage.codex-reset.consume",
  input: resetAttemptSchema.extend({ confirmed: z.literal(true) }),
  output: resetResponseSchema.extend({ usage: usageSchema }),
});

export const resetOutcomeMessages: Record<ResetOutcome, string> = {
  reset: "Banked reset used. Your eligible Codex quota has been reset.",
  alreadyRedeemed:
    "This reset was already applied. No additional credit was used.",
  nothingToReset: "No eligible quota needs resetting. No credit was used.",
  noCredit: "No banked resets are available on this account.",
};
