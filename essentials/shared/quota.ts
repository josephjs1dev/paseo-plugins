import { z } from "zod";
import { creditsSchema, type Usage } from "./usage";

const windowSchema = z.object({
  usedPercent: z.number().finite().nonnegative(),
  windowDurationMins: z.number().nonnegative().nullable().optional(),
  resetsAt: z
    .number()
    .int()
    .nonnegative()
    .max(253_402_300_799)
    .nullable()
    .optional(),
});
const bucketSchema = z.object({
  limitName: z.string().max(100).nullable().optional(),
  primary: windowSchema.nullable().optional(),
  secondary: windowSchema.nullable().optional(),
});
const codexSchema = z.object({
  rateLimits: bucketSchema.nullable().optional(),
  rateLimitsByLimitId: z.record(z.string().max(100), bucketSchema).optional(),
});

const creditSnapshotSchema = z.object({
  hasCredits: z.boolean(),
  unlimited: z.boolean(),
  balance: z
    .string()
    .max(80)
    .regex(/^\d+(?:\.\d+)?$/)
    .transform(Number)
    .pipe(z.number().finite().nonnegative())
    .nullable(),
});

/** Credit metadata is optional; malformed details must not hide valid quota windows. */
export function normalizeCodexCredits(input: unknown): Usage["credits"] {
  const creditBucket = z.object({ credits: z.unknown().optional() });
  const response = z
    .object({
      rateLimits: creditBucket.nullish(),
      rateLimitsByLimitId: z.record(z.string(), creditBucket).optional(),
    })
    .safeParse(input);

  if (!response.success) {
    return null;
  }

  const { rateLimits, rateLimitsByLimitId } = response.data;
  const bucket = rateLimitsByLimitId?.codex ?? rateLimits;
  const parsed = creditSnapshotSchema
    .pipe(creditsSchema)
    .safeParse(bucket?.credits);

  return parsed.success ? parsed.data : null;
}

export function normalizeCodexResetCredits(
  input: unknown,
  now = Date.now(),
): Usage["resetCredits"] {
  const data = z
    .object({
      rateLimitResetCredits: z
        .object({
          availableCount: z.number().int().nonnegative(),
          credits: z.unknown().optional(),
        })
        .nullish(),
    })
    .parse(input);

  const snapshot = data.rateLimitResetCredits;

  if (!snapshot) {
    return null;
  }

  // Optional details must not hide a valid count on older Codex versions.
  const details = z
    .array(
      z.object({
        resetType: z.string().max(100),
        status: z.string().max(100),
        expiresAt: z
          .number()
          .int()
          .nonnegative()
          .max(253_402_300_799)
          .nullable(),
      }),
    )
    .max(1000)
    .safeParse(snapshot.credits);
  let earliest: number | undefined;

  if (snapshot.availableCount > 0 && details.success) {
    for (const credit of details.data) {
      if (
        credit.status === "available" &&
        credit.resetType === "codexRateLimits" &&
        credit.expiresAt !== null &&
        credit.expiresAt * 1000 > now &&
        (earliest === undefined || credit.expiresAt < earliest)
      ) {
        earliest = credit.expiresAt;
      }
    }
  }

  return {
    availableCount: snapshot.availableCount,
    ...(earliest === undefined
      ? {}
      : { earliestExpiresAt: new Date(earliest * 1000).toISOString() }),
  };
}

export function normalizeCodex(input: unknown): Usage["windows"] {
  const data = codexSchema.parse(input);
  const buckets = Object.entries(data.rateLimitsByLimitId ?? {});

  if (!buckets.length && data.rateLimits) {
    buckets.push(["codex", data.rateLimits]);
  }

  if (buckets.length > 32) {
    throw new Error("Too many quota buckets");
  }

  return buckets.flatMap(([id, bucket]) =>
    (["primary", "secondary"] as const).flatMap((key) => {
      const window = bucket[key];

      if (!window) {
        return [];
      }

      const minutes = window.windowDurationMins;
      const duration = formatWindowDuration(minutes, key);

      return [
        {
          name: `${bucket.limitName ?? id} · ${duration}`,
          usedPercent: window.usedPercent,
          resetsAt:
            window.resetsAt == null
              ? null
              : new Date(window.resetsAt * 1000).toISOString(),
        },
      ];
    }),
  );
}

function formatWindowDuration(
  minutes: number | null | undefined,
  fallback: string,
): string {
  if (!minutes) {
    return fallback;
  }

  if (minutes % 1440 === 0) {
    return `${minutes / 1440}d`;
  }

  if (minutes % 60 === 0) {
    return `${minutes / 60}h`;
  }

  return `${minutes}m`;
}

const goWindow = z.object({
  status: z.enum(["ok", "rate-limited"]),
  percent: z.number().finite().nonnegative(),
  resetsAt: z.string().datetime({ offset: true }),
});
const goSchema = z.object({
  usage: z.object({ rolling: goWindow, weekly: goWindow, monthly: goWindow }),
});

export function normalizeGo(input: unknown): Usage["windows"] {
  const { usage } = goSchema.parse(input);

  return (["rolling", "weekly", "monthly"] as const).map((key) => ({
    name: { rolling: "5 hours", weekly: "Weekly", monthly: "Monthly" }[key],
    usedPercent: usage[key].percent,
    resetsAt: new Date(usage[key].resetsAt).toISOString(),
  }));
}
