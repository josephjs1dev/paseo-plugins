import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeCodex,
  normalizeCodexResetCredits,
  normalizeGo,
} from "../../shared/quota";
import { usageLabel, usageSchema } from "../../shared/usage";

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

test("Codex reset counts distinguish unsupported, zero, and truncated credit details", () => {
  assert.equal(normalizeCodexResetCredits({}), null);
  assert.equal(
    normalizeCodexResetCredits({ rateLimitResetCredits: null }),
    null,
  );
  assert.deepEqual(
    normalizeCodexResetCredits({
      rateLimitResetCredits: { availableCount: 0, credits: [] },
    }),
    { availableCount: 0 },
  );
  assert.deepEqual(
    normalizeCodexResetCredits({
      rateLimitResetCredits: { availableCount: 3, credits: null },
    }),
    { availableCount: 3 },
  );
  assert.deepEqual(
    normalizeCodexResetCredits({
      rateLimitResetCredits: {
        availableCount: 3,
        credits: [{ id: "one-row-only" }],
      },
    }),
    { availableCount: 3 },
  );

  for (const availableCount of [-1, 1.5, "2", Infinity]) {
    assert.throws(() =>
      normalizeCodexResetCredits({ rateLimitResetCredits: { availableCount } }),
    );
  }
});

test("Codex supports all named buckets without duplicating the legacy bucket", () => {
  const windows = normalizeCodex({
    rateLimits: { primary: codexWindow },
    rateLimitsByLimitId: {
      codex: {
        primary: codexWindow,
        secondary: {
          ...codexWindow,
          usedPercent: 80,
          windowDurationMins: 10080,
        },
      },
      extra: {
        limitName: "Other models",
        primary: { ...codexWindow, resetsAt: null },
      },
    },
  });
  assert.equal(windows.length, 3);
  assert.equal(windows[1]?.name, "codex · 7d");
  assert.equal(windows[2]?.resetsAt, null);
  assert.equal(
    normalizeCodex({ rateLimits: { primary: codexWindow } }).length,
    1,
  );
  const usage = usageSchema.parse({
    provider: "codex",
    status: "ok",
    message: "",
    checkedAt: new Date().toISOString(),
    windows,
  });
  assert.equal(usageLabel(usage), "Codex · 20% left");
});

test("Go preserves quota percentages and normalizes reset time zones", () => {
  const windows = normalizeGo({
    usage: {
      rolling: goWindow,
      weekly: { ...goWindow, status: "rate-limited", percent: 100 },
      monthly: { ...goWindow, resetsAt: "2027-01-15T10:00:00+02:00" },
    },
  });
  assert.deepEqual(
    windows.map((window) => window.usedPercent),
    [42, 100, 42],
  );
  assert.equal(windows[2]?.resetsAt, "2027-01-15T08:00:00.000Z");
});

test("malformed quota data is rejected instead of becoming zero usage", () => {
  assert.throws(() =>
    normalizeCodex({
      rateLimits: { primary: { ...codexWindow, usedPercent: "25" } },
    }),
  );
  assert.throws(() =>
    normalizeCodex({
      rateLimits: { primary: { ...codexWindow, resetsAt: 1e20 } },
    }),
  );
  assert.throws(() => normalizeGo({ usage: { rolling: goWindow } }));
  assert.throws(() =>
    normalizeGo({
      usage: {
        rolling: { ...goWindow, percent: -1 },
        weekly: goWindow,
        monthly: goWindow,
      },
    }),
  );
});
