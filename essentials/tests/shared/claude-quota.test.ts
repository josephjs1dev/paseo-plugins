import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeClaude } from "../../shared/quota";
import { normalizeCodex } from "../../shared/quota";
import { usageLabel, usageSchema } from "../../shared/usage";

const window = { utilization: 25, resets_at: "2026-10-05T18:00:00+02:00" };

test("Claude normalizes five-hour, weekly, and model-specific quotas", () => {
  const windows = normalizeClaude({
    five_hour: window,
    seven_day: { ...window, utilization: 100 },
    seven_day_sonnet: { utilization: 0, resets_at: null },
    seven_day_opus: null,
    extra_usage: { is_enabled: false },
  });
  assert.deepEqual(windows, [
    {
      name: "5 hours",
      durationMinutes: 300,
      usedPercent: 25,
      resetsAt: "2026-10-05T16:00:00.000Z",
    },
    {
      name: "Weekly",
      durationMinutes: 10080,
      usedPercent: 100,
      resetsAt: "2026-10-05T16:00:00.000Z",
    },
    {
      name: "Sonnet · weekly",
      durationMinutes: 10080,
      usedPercent: 0,
      resetsAt: null,
    },
  ]);
  assert.equal(label("claude", windows), "Claude · 5h 75% left");
});

test("absent Claude five-hour usage never becomes a fabricated full balance", () => {
  const windows = normalizeClaude({ five_hour: null, seven_day: window });
  assert.equal(windows.length, 1);
  assert.equal(label("claude", windows), "Claude · 75% left");
  assert.deepEqual(normalizeClaude({}), []);
  assert.equal(label("claude", []), "Claude · —");
});

test("Claude rejects malformed measured usage and reset timestamps", () => {
  for (const utilization of [-1, "25", Infinity, NaN, null]) {
    assert.throws(() =>
      normalizeClaude({ five_hour: { ...window, utilization } }),
    );
  }

  assert.throws(() =>
    normalizeClaude({ five_hour: { ...window, resets_at: "tomorrow" } }),
  );
  assert.equal(
    normalizeClaude({ five_hour: { utilization: 125 } })[0]?.usedPercent,
    125,
  );
  assert.equal(
    label("claude", normalizeClaude({ five_hour: { utilization: 125 } })),
    "Claude · 5h 0% left",
  );
});

test("Codex keeps the main five-hour limit alongside unrelated named buckets", () => {
  const primary = { usedPercent: 20, windowDurationMins: 300, resetsAt: null };
  const windows = normalizeCodex({
    rateLimits: { primary },
    rateLimitsByLimitId: {
      reviews: {
        secondary: { ...primary, windowDurationMins: 10080, usedPercent: 80 },
      },
    },
  });
  assert.equal(windows.length, 2);
  assert.equal(windows[0]?.name, "codex · 5h");
  assert.equal(label("chatgpt", windows), "ChatGPT · 5h 80% left");

  const named = normalizeCodex({
    rateLimits: { limitId: "reviews", primary },
    rateLimitsByLimitId: {
      reviews: { primary: { ...primary, usedPercent: 40 } },
    },
  });
  assert.equal(named.length, 1);
  assert.equal(named[0]?.usedPercent, 40);
});

test("Codex only labels an explicitly reported five-hour duration", () => {
  const primary = { usedPercent: 20 };
  assert.equal(
    label("chatgpt", normalizeCodex({ rateLimits: { primary } })),
    "ChatGPT · 80% left",
  );
  assert.equal(
    label(
      "chatgpt",
      normalizeCodex({
        rateLimits: { primary: { ...primary, windowDurationMins: 10080 } },
      }),
    ),
    "ChatGPT · 80% left",
  );
});

function label(
  provider: "claude" | "chatgpt",
  windows: ReturnType<typeof normalizeClaude>,
) {
  return usageLabel(
    usageSchema.parse({
      provider,
      windows,
      status: "ok",
      message: "",
      checkedAt: "2026-10-05T12:00:00.000Z",
    }),
  );
}
