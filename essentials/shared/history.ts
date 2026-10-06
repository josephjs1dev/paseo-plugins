import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { providerSchema } from "./providers";
import { harnessSchema } from "./harnesses";

const count = z.number().finite().nonnegative();

const costEstimateSchema = z.object({
  amount: count.nullable(),
  pricedTokens: count,
  unpricedTokens: count,
});
// Rate-based USD estimate with coverage for models that have published rates.
export type CostEstimate = z.infer<typeof costEstimateSchema>;

export const totalsSchema = z.object({
  input: count,
  cached: count,
  output: count,
  reasoning: count,
  // Recorded model-cost estimate in USD, not a subscription charge.
  cost: count.nullable(),
  costEstimate: costEstimateSchema.optional(),
});

export type Totals = z.infer<typeof totalsSchema>;

export const historyRowSchema = z.object({
  provider: providerSchema,
  harness: harnessSchema,
  sessionId: z.string().max(160),
  model: z.string().max(160).nullable().optional(),
  cwd: z.string().max(4096),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lastAt: z.string().datetime(),
  totals: totalsSchema,
});

export type HistoryRow = z.infer<typeof historyRowSchema>;

export const historyCollectionSchema = z.object({
  rows: z.array(historyRowSchema).max(100_000),
  incomplete: z.boolean(),
});
export type HistoryCollection = z.infer<typeof historyCollectionSchema>;

export const historyScopeSchema = z.enum(["workspace", "host"]);
export type HistoryScope = z.infer<typeof historyScopeSchema>;

const modelSummarySchema = z.object({
  model: z.string().nullable(),
  totals: totalsSchema,
  sessionCount: count.int(),
});

const sessionSummarySchema = z.object({
  harness: harnessSchema,
  sessionId: z.string(),
  cwd: z.string().max(4096),
  lastAt: z.string(),
  totals: totalsSchema,
  models: z.array(
    z.object({ model: z.string().nullable(), totals: totalsSchema }),
  ),
});

export const readHistory = defineRpc({
  name: "usage.history",
  input: z.object({
    provider: providerSchema,
    workspaceId: z.string().min(1).max(160),
    days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
    scope: historyScopeSchema.default("workspace"),
    sessionOffset: z.number().int().min(0).max(100_000).default(0),
    refresh: z.boolean().optional(),
  }),
  output: z.object({
    scannedAt: z.string().datetime().nullable(),
    warning: z.string().max(400),
    refreshing: z.boolean().optional(),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    daily: z.array(z.object({ day: z.string(), totals: totalsSchema })).max(90),
    workspaceDaily: z
      .array(z.object({ day: z.string(), totals: totalsSchema }))
      .max(90),
    workspaceTotals: totalsSchema,
    workspaceSessionCount: count,
    workspaceModels: z.array(modelSummarySchema),
    sessionCount: count.int(),
    models: z.array(modelSummarySchema),
    sessions: z.array(sessionSummarySchema).max(20),
    totals: totalsSchema,
  }),
});

export type History = z.infer<typeof readHistory.output>;

export function addTotals(a: Totals, b: Totals): Totals {
  return {
    input: a.input + b.input,
    cached: a.cached + b.cached,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cost: a.cost === null || b.cost === null ? null : a.cost + b.cost,
    ...(a.costEstimate !== undefined || b.costEstimate !== undefined
      ? { costEstimate: addCostEstimates(a, b) }
      : {}),
  };
}

function addCostEstimates(a: Totals, b: Totals): CostEstimate {
  const missing = (totals: Totals): CostEstimate => ({
    amount: null,
    pricedTokens: 0,
    unpricedTokens: totals.input + totals.output,
  });
  const first = a.costEstimate ?? missing(a);
  const second = b.costEstimate ?? missing(b);
  const pricedTokens = first.pricedTokens + second.pricedTokens;
  const unpricedTokens = first.unpricedTokens + second.unpricedTokens;

  return {
    amount:
      (pricedTokens === 0 && unpricedTokens > 0) ||
      (first.amount === null && second.amount === null)
        ? null
        : (first.amount ?? 0) + (second.amount ?? 0),
    pricedTokens,
    unpricedTokens,
  };
}

export function emptyTotals(): Totals {
  return { input: 0, cached: 0, output: 0, reasoning: 0, cost: 0 };
}
