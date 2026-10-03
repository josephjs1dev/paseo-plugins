import assert from "node:assert/strict";
import { test } from "node:test";

import {
  creditBalanceLabel,
  formatResetTime,
  remainingPercent,
} from "../../shared/usage-display";

test("credit labels distinguish missing balance, known zero, and unlimited", () => {
  assert.equal(creditBalanceLabel(undefined), "Unavailable");
  assert.equal(creditBalanceLabel(null), "Unavailable");
  const credits = { hasCredits: true, unlimited: false, balance: null };
  assert.equal(creditBalanceLabel(credits), "Available · balance unavailable");
  assert.equal(
    creditBalanceLabel({ ...credits, hasCredits: false }),
    "No credits available",
  );
  assert.equal(
    creditBalanceLabel({ ...credits, unlimited: true }),
    "Unlimited",
  );
  assert.equal(creditBalanceLabel({ ...credits, balance: 0 }), "0");
  assert.equal(
    creditBalanceLabel({ ...credits, balance: 2500.5 }),
    new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(
      2500.5,
    ),
  );
});

test("remaining quota is bounded even after a provider reports overage", () => {
  assert.equal(remainingPercent(27), 73);
  assert.equal(remainingPercent(125), 0);
  assert.equal(remainingPercent(-5), 100);
});

test("reset labels handle missing, expired, short, and long windows", () => {
  const now = Date.parse("2026-09-25T00:00:00Z");

  assert.equal(formatResetTime(null, now), "Reset time unavailable");
  assert.equal(formatResetTime("2026-09-24T00:00:00Z", now), "Reset due");
  assert.equal(formatResetTime("2026-09-25T00:00:30Z", now), "Resets in 1m");
  assert.equal(
    formatResetTime("2026-09-25T02:18:00Z", now),
    "Resets in 2h 18m",
  );
  assert.equal(formatResetTime("2026-09-29T07:00:00Z", now), "Resets in 4d 7h");
});
