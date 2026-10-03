import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyTotals } from "../../shared/history";
import { historyBuckets } from "../../shared/history-display";

const daily = Array.from({ length: 90 }, (_, index) => ({
  day: new Date(Date.UTC(2026, 8, 26 - index)).toISOString().slice(0, 10),
  totals: { ...emptyTotals(), input: 100, output: 20, cost: 0.1 },
}));

test("7 days shows seven UTC daily buckets", () => {
  const buckets = historyBuckets(daily, 7, "2026-09-26");
  assert.equal(buckets.length, 7);
  assert.equal(buckets[0]?.startDay, "2026-09-20");
  assert.equal(buckets[6]?.endDay, "2026-09-26");
  assert.ok(
    buckets.every(
      (bucket) =>
        bucket.startDay === bucket.endDay && bucket.totals.input === 100,
    ),
  );
});

test("30 days keeps all days in four full weeks and a labeled two-day remainder", () => {
  const buckets = historyBuckets(daily, 30, "2026-09-26");
  assert.equal(buckets.length, 5);
  assert.deepEqual(
    buckets.map((bucket) => bucket.totals.input),
    [200, 700, 700, 700, 700],
  );
  assert.equal(buckets[0]?.startDay, "2026-08-28");
  assert.equal(buckets[0]?.endDay, "2026-08-29");
  assert.equal(buckets[4]?.startDay, "2026-09-20");
  assert.equal(buckets[4]?.endDay, "2026-09-26");
});

test("90 days shows three 30-day buckets, not calendar months", () => {
  const buckets = historyBuckets(daily, 90, "2026-09-26");
  assert.equal(buckets.length, 3);
  assert.deepEqual(
    buckets.map((bucket) => bucket.totals.input),
    [3000, 3000, 3000],
  );
  assert.equal(buckets[0]?.startDay, "2026-06-29");
  assert.equal(buckets[2]?.endDay, "2026-09-26");
});

test("empty intervals and unknown costs stay distinguishable across year boundaries", () => {
  const buckets = historyBuckets(
    [
      { day: "2025-12-31", totals: { ...emptyTotals(), input: 1, cost: null } },
      { day: "2026-01-02", totals: { ...emptyTotals(), input: 2 } },
      { day: "2026-01-03", totals: { ...emptyTotals(), input: 999 } },
    ],
    7,
    "2026-01-02",
  );
  assert.equal(buckets[0]?.startDay, "2025-12-27");
  assert.equal(buckets[0]?.hasUsage, false);
  assert.equal(buckets[4]?.hasUsage, true);
  assert.equal(buckets[4]?.totals.cost, null);
  assert.equal(
    buckets.reduce((sum, bucket) => sum + bucket.totals.input, 0),
    3,
  );
});
