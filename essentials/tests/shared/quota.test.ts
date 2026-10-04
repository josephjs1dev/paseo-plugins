import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeCodex,
  normalizeCodexCredits,
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

test("Codex credit balances preserve zero, fractions, unlimited, and unavailable states", () => {
  const credits = { hasCredits: true, unlimited: false, balance: "2500.5" };
  assert.deepEqual(normalizeCodexCredits({ rateLimits: { credits } }), {
    ...credits,
    balance: 2500.5,
  });
  assert.deepEqual(
    normalizeCodexCredits({
      rateLimits: { credits: { ...credits, hasCredits: false, balance: "0" } },
    }),
    { ...credits, hasCredits: false, balance: 0 },
  );
  assert.deepEqual(
    normalizeCodexCredits({
      rateLimits: { credits: { ...credits, unlimited: true, balance: null } },
    }),
    { ...credits, unlimited: true, balance: null },
  );
  assert.deepEqual(
    normalizeCodexCredits({
      rateLimits: { credits: { ...credits, balance: null } },
    }),
    { ...credits, balance: null },
  );
  assert.equal(normalizeCodexCredits({}), null);
  assert.equal(normalizeCodexCredits({ rateLimits: { credits: null } }), null);
});

test("Codex credit lookup selects the Codex bucket and ignores unrelated limits", () => {
  const credits = { hasCredits: true, unlimited: false, balance: "100" };
  assert.equal(
    normalizeCodexCredits({ rateLimitsByLimitId: { other: { credits } } }),
    null,
  );
  assert.deepEqual(
    normalizeCodexCredits({
      rateLimits: { credits: { ...credits, balance: "999" } },
      rateLimitsByLimitId: { codex: { credits } },
    }),
    { ...credits, balance: 100 },
  );
  assert.equal(
    normalizeCodexCredits({
      rateLimits: { credits },
      rateLimitsByLimitId: { codex: { credits: null } },
    }),
    null,
  );
});

test("malformed optional credit metadata does not discard valid quota windows", () => {
  for (const balance of [
    "",
    "-1",
    "NaN",
    "Infinity",
    "abc",
    42,
    "9".repeat(81),
  ]) {
    const response = {
      rateLimits: {
        primary: codexWindow,
        credits: { hasCredits: true, unlimited: false, balance },
      },
    };
    assert.equal(normalizeCodexCredits(response), null);
    assert.equal(normalizeCodex(response)[0]?.usedPercent, 25);
  }

  assert.equal(
    normalizeCodexCredits({
      rateLimits: {
        credits: { hasCredits: "true", unlimited: false, balance: "1" },
      },
    }),
    null,
  );
});

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

test("banked reset expiry selects the earliest upcoming eligible credit", () => {
  const now = 1_800_000_000;
  const credit = (expiresAt: number | null) => ({
    resetType: "codexRateLimits",
    status: "available",
    expiresAt,
  });
  const resetCredits = normalizeCodexResetCredits(
    {
      rateLimitResetCredits: {
        availableCount: 3,
        credits: [
          credit(now + 7200),
          credit(null),
          credit(now - 1),
          credit(now),
          { ...credit(now + 1), status: "redeemed" },
          { ...credit(now + 2), resetType: "other" },
          credit(now + 3600),
        ],
      },
    },
    now * 1000,
  );
  assert.deepEqual(resetCredits, {
    availableCount: 3,
    earliestExpiresAt: new Date((now + 3600) * 1000).toISOString(),
  });
  assert.deepEqual(
    usageSchema.shape.resetCredits.parse(resetCredits),
    resetCredits,
  );
});

test("banked reset expiry is omitted when unavailable without losing the count", () => {
  const now = 1_800_000_000;

  for (const expiresAt of [null, now - 1, now, "tomorrow", 1e20]) {
    assert.deepEqual(
      normalizeCodexResetCredits(
        {
          rateLimitResetCredits: {
            availableCount: 1,
            credits: [
              { resetType: "codexRateLimits", status: "available", expiresAt },
            ],
          },
        },
        now * 1000,
      ),
      { availableCount: 1 },
    );
  }

  assert.deepEqual(
    normalizeCodexResetCredits(
      {
        rateLimitResetCredits: {
          availableCount: 0,
          credits: [
            {
              resetType: "codexRateLimits",
              status: "available",
              expiresAt: now + 1,
            },
          ],
        },
      },
      now * 1000,
    ),
    { availableCount: 0 },
  );
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
    provider: "chatgpt",
    status: "ok",
    message: "",
    checkedAt: new Date().toISOString(),
    windows,
  });
  assert.equal(usageLabel(usage), "ChatGPT · 20% left");
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
