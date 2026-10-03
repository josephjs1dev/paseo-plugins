import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createCodexResetter } from "../../server/codex-reset";
import { createUsageReader } from "../../server/usage";
import {
  prepareCodexReset,
  consumeCodexReset,
  type ResetAttempt,
} from "../../shared/codex-reset";

const now = 1_800_000_000;
const credit = (
  id: string,
  expiresAt: number | null,
  grantedAt = now - 100,
) => ({
  id,
  expiresAt,
  grantedAt,
  status: "available",
  resetType: "codexRateLimits",
});
const limits = (credits: unknown, availableCount = 3) => ({
  rateLimitResetCredits: { availableCount, credits },
});
const createReader = () =>
  createUsageReader(async () => ({
    windows: [],
    resetCredits: { availableCount: 3 },
  }));

const selectionCases = [
  {
    name: "soonest expiry takes precedence over grant date and permanent credits",
    input: limits([
      credit("permanent", null, 1),
      credit("later", now + 200, 2),
      credit("soon", now + 100, 3),
    ]),
    expected: "soon",
  },
  {
    name: "equal expiries prefer the oldest grant",
    input: limits([
      credit("newer", now + 100, 2),
      credit("older", now + 100, 1),
    ]),
    expected: "older",
  },
  {
    name: "permanent credits prefer the oldest grant",
    input: limits([credit("newer", null, 2), credit("older", null, 1)]),
    expected: "older",
  },
  {
    name: "identical timestamps use a stable credit ID order",
    input: limits([credit("b", now + 100), credit("a", now + 100)]),
    expected: "a",
  },
  {
    name: "expired, redeemed, and other reset types are skipped",
    input: limits([
      credit("expired", now - 1),
      credit("expires-now", now),
      { ...credit("redeemed", now + 1), status: "redeemed" },
      { ...credit("other", now + 1), resetType: "other" },
      credit("eligible", now + 100),
    ]),
    expected: "eligible",
  },
  {
    name: "truncated details still prefer the earliest reported credit",
    input: limits([credit("reported", now + 100)], 10),
    expected: "reported",
  },
  {
    name: "missing reset support uses service selection",
    input: {},
    expected: undefined,
  },
  {
    name: "null reset support uses service selection",
    input: { rateLimitResetCredits: null },
    expected: undefined,
  },
  {
    name: "count-only replies use service selection",
    input: { rateLimitResetCredits: { availableCount: 3 } },
    expected: undefined,
  },
  {
    name: "null details use service selection",
    input: limits(null),
    expected: undefined,
  },
  {
    name: "empty details use service selection",
    input: limits([]),
    expected: undefined,
  },
  {
    name: "no eligible details use service selection",
    input: limits([credit("expired", now)]),
    expected: undefined,
  },
  {
    name: "zero count is authoritative",
    input: limits([credit("stale", now + 100)], 0),
    expected: undefined,
  },
];

for (const { name, input, expected } of selectionCases) {
  test(name, async (context) => {
    context.mock.method(Date, "now", () => now * 1000);
    const reader = createReader();
    const requests: ResetAttempt[] = [];
    const resetter = createCodexResetter(
      reader,
      async (request) => {
        requests.push(request);

        return { outcome: "reset" };
      },
      async () => input,
    );

    try {
      const attempt = prepareCodexReset.output.parse(await resetter.prepare());
      assert.equal(attempt.creditId, expected);
      assert.equal(requests.length, 0);
      const confirmed = consumeCodexReset.input.parse({
        ...attempt,
        confirmed: true,
      });
      await resetter.consume({
        idempotencyKey: confirmed.idempotencyKey,
        creditId: confirmed.creditId,
      });
      assert.deepEqual(requests, [attempt]);
    } finally {
      resetter.close();
      reader.close();
    }
  });
}

test("concurrent preparation shares one read and pins the credit across failures and reloads", async (context) => {
  context.mock.method(Date, "now", () => now * 1000);
  const reader = createReader();
  let reads = 0;
  let current = limits([credit("first", now + 1)]);
  const requests: ResetAttempt[] = [];
  let resetter = createCodexResetter(
    reader,
    async (request) => {
      requests.push({ ...request });
      throw new Error("uncertain");
    },
    async () => {
      reads++;

      return current;
    },
  );

  try {
    const [first, second] = await Promise.all([
      resetter.prepare(),
      resetter.prepare(),
    ]);
    assert.deepEqual(first, second);
    assert.equal(reads, 1);
    await assert.rejects(resetter.consume(first), /Could not confirm/);
    current = limits([credit("different", now + 100)]);
    context.mock.method(Date, "now", () => (now + 2) * 1000);
    assert.deepEqual(await resetter.prepare(), first);
    await assert.rejects(
      resetter.consume({ ...first, creditId: "different" }),
      /without changing/,
    );
    await assert.rejects(resetter.consume(first), /Could not confirm/);
    assert.equal(reads, 1);
    resetter.close();

    resetter = createCodexResetter(
      reader,
      async (request) => {
        requests.push({ ...request });

        return { outcome: "alreadyRedeemed" };
      },
      async () => {
        assert.fail(
          "A retained attempt must not read or select another credit",
        );
      },
    );
    await resetter.consume(first);
    assert.deepEqual(requests, [first, first, first]);
    assert.equal(first.creditId, "first");
  } finally {
    resetter.close();
    reader.close();
  }
});

test("failed or malformed preparation spends nothing, sanitizes errors, and can be retried", async () => {
  const reader = createReader();
  let reads = 0;
  const resetter = createCodexResetter(
    reader,
    async () => {
      assert.fail("Preparing must not redeem a credit");
    },
    async () => {
      reads++;

      if (reads === 1) {
        throw new Error("private-token");
      }

      if (reads === 2) {
        return limits([{ ...credit("bad", null), expiresAt: "tomorrow" }]);
      }

      return limits([credit("valid", null)]);
    },
  );

  try {
    const pending = [resetter.prepare(), resetter.prepare()];

    for (const attempt of pending) {
      await assert.rejects(attempt, (error: Error) => {
        assert.equal(error.message.includes("private-token"), false);

        return error.message.includes("Could not prepare");
      });
    }

    assert.equal(reads, 1);
    await assert.rejects(resetter.prepare(), /Could not prepare/);
    assert.equal((await resetter.prepare()).creditId, "valid");
  } finally {
    resetter.close();
    reader.close();
  }
});

test("a retained request arriving during preparation keeps its original credit", async () => {
  const reader = createReader();
  let finishRead: (value: unknown) => void = () =>
    assert.fail("Read not started");
  const resetter = createCodexResetter(
    reader,
    async () => {
      throw new Error("uncertain");
    },
    () =>
      new Promise((resolve) => {
        finishRead = resolve;
      }),
  );

  try {
    const pending = resetter.prepare();
    const retained = { idempotencyKey: randomUUID(), creditId: "original" };
    await assert.rejects(resetter.consume(retained), /Could not confirm/);
    finishRead(limits([credit("different", null)]));
    assert.deepEqual(await pending, retained);
  } finally {
    resetter.close();
    reader.close();
  }
});

test("cleanup cancels preparation without issuing a reset", async () => {
  const reader = createReader();
  const resetter = createCodexResetter(
    reader,
    async () => {
      assert.fail("Cancelled preparation must not redeem");
    },
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      }),
  );

  try {
    const pending = resetter.prepare();
    resetter.close();
    await assert.rejects(pending, /Could not prepare/);
    await assert.rejects(resetter.prepare(), /unavailable/);
  } finally {
    resetter.close();
    reader.close();
  }
});
