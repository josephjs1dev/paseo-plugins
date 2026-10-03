import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCodexResetter } from "../../server/codex-reset";
import { redeemCodexReset } from "../../server/collectors/codex";
import { createUsageReader } from "../../server/usage";
import {
  consumeCodexReset,
  type ResetAttempt,
  type ResetOutcome,
} from "../../shared/codex-reset";
import type { Quota } from "../../shared/usage";

const quota = (availableCount: number, usedPercent: number): Quota => ({
  windows: [{ name: "Codex", usedPercent, resetsAt: null }],
  resetCredits: { availableCount },
});

// All service reads are stubbed; these tests never access a real Codex account.
function createTestResetter(
  reader: Parameters<typeof createCodexResetter>[0],
  redeem?: Parameters<typeof createCodexResetter>[1],
  readLimits: Parameters<typeof createCodexResetter>[2] = async () => ({}),
) {
  return createCodexResetter(reader, redeem, readLimits);
}

test("redemption requires an explicit confirmation and a valid retry key", () => {
  const idempotencyKey = randomUUID();
  assert.equal(
    consumeCodexReset.input.safeParse({ idempotencyKey }).success,
    false,
  );
  assert.equal(
    consumeCodexReset.input.safeParse({ idempotencyKey, confirmed: false })
      .success,
    false,
  );
  assert.equal(
    consumeCodexReset.input.safeParse({ idempotencyKey: "", confirmed: true })
      .success,
    false,
  );
  assert.equal(
    consumeCodexReset.input.safeParse({ idempotencyKey, confirmed: true })
      .success,
    true,
  );

  for (const creditId of ["", null, 1, "x".repeat(1025)]) {
    assert.equal(
      consumeCodexReset.input.safeParse({
        idempotencyKey,
        confirmed: true,
        creditId,
      }).success,
      false,
    );
  }
});

test("preparing/cancelling spends nothing; duplicate confirmations spend once and bypass quota cache", async () => {
  let current = quota(2, 100);
  let reads = 0;
  let redemptions = 0;
  const reader = createUsageReader(async () => {
    reads++;

    return current;
  });
  const resetter = createTestResetter(reader, async () => {
    redemptions++;
    current = quota(1, 0);

    return { outcome: "reset" };
  });

  try {
    assert.equal((await reader.read("chatgpt")).windows[0]?.usedPercent, 100);
    const attempt = await resetter.prepare();
    assert.deepEqual(await resetter.prepare(), attempt);
    assert.equal(redemptions, 0);
    const [first, second] = await Promise.all([
      resetter.consume(attempt),
      resetter.consume(attempt),
    ]);
    assert.deepEqual(first, second);
    assert.equal(first.usage.resetCredits?.availableCount, 1);
    assert.equal(first.usage.windows[0]?.usedPercent, 0);
    assert.equal(reads, 2);
    assert.equal(redemptions, 1);
    await resetter.consume(attempt);
    assert.equal(redemptions, 1);
    assert.notEqual(
      (await resetter.prepare()).idempotencyKey,
      attempt.idempotencyKey,
    );
  } finally {
    resetter.close();
    reader.close();
  }
});

test("uncertain failures retain the same redemption key and sanitize remote errors", async () => {
  const reader = createUsageReader(async () => quota(1, 0));
  const keys: string[] = [];
  const resetter = createTestResetter(reader, async ({ idempotencyKey }) => {
    keys.push(idempotencyKey);

    if (keys.length === 1) {
      throw new Error("private-token");
    }

    return { outcome: "alreadyRedeemed" };
  });

  try {
    const attempt = await resetter.prepare();
    await assert.rejects(resetter.consume(attempt), (error: Error) => {
      assert.equal(error.message.includes("private-token"), false);

      return error.message.includes("Could not confirm");
    });
    assert.deepEqual(await resetter.prepare(), attempt);
    await assert.rejects(
      resetter.consume({ idempotencyKey: randomUUID() }),
      /Another reset is in progress/,
    );
    assert.equal((await resetter.consume(attempt)).outcome, "alreadyRedeemed");
    assert.deepEqual(keys, [attempt.idempotencyKey, attempt.idempotencyKey]);
  } finally {
    resetter.close();
    reader.close();
  }
});

test("a retained client key can be retried after plugin reload", async () => {
  const reader = createUsageReader(async () => quota(1, 0));
  const previous = createTestResetter(reader);
  const attempt = await previous.prepare();
  previous.close();
  const resetter = createTestResetter(reader, async (request) => {
    assert.deepEqual(request, attempt);

    return { outcome: "alreadyRedeemed" };
  });

  try {
    assert.equal((await resetter.consume(attempt)).outcome, "alreadyRedeemed");
  } finally {
    resetter.close();
    reader.close();
  }
});

test("cleanup aborts redemption and concurrent different attempts are blocked", async () => {
  const reader = createUsageReader(async () => quota(1, 0));
  const resetter = createTestResetter(
    reader,
    async (_key, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      }),
  );

  try {
    const attempt = await resetter.prepare();
    const pending = resetter.consume(attempt);
    await assert.rejects(
      resetter.consume({ idempotencyKey: randomUUID() }),
      /Another reset is in progress/,
    );
    resetter.close();
    await assert.rejects(pending, /Could not confirm/);
    await assert.rejects(resetter.prepare(), /unavailable/);
    await assert.rejects(resetter.consume(attempt), /unavailable/);
  } finally {
    resetter.close();
    reader.close();
  }
});

for (const outcome of ["nothingToReset", "noCredit"] as const) {
  test(`${outcome} refreshes stale counts and quota`, async () => {
    let current = quota(2, 100);
    const reader = createUsageReader(async () => current);
    const resetter = createTestResetter(reader, async () => {
      current = quota(outcome === "noCredit" ? 0 : 2, 0);

      return { outcome };
    });

    try {
      await reader.read("chatgpt");
      const result = await resetter.consume(await resetter.prepare());
      assert.equal(result.outcome, outcome);
      assert.deepEqual(result.usage.windows, current.windows);
      assert.deepEqual(result.usage.resetCredits, current.resetCredits);
    } finally {
      resetter.close();
      reader.close();
    }
  });
}

test("a failed quota refresh does not hide successful redemption or repeat it", async () => {
  const reader = createUsageReader(async () => {
    throw new Error("unavailable");
  });
  let calls = 0;
  const resetter = createTestResetter(reader, async () => {
    calls++;

    return { outcome: "reset" };
  });

  try {
    const attempt = await resetter.prepare();
    const result = await resetter.consume(attempt);
    assert.equal(result.outcome, "reset");
    assert.equal(result.usage.status, "unavailable");
    await resetter.consume(attempt);
    assert.equal(calls, 1);
  } finally {
    resetter.close();
    reader.close();
  }
});

test("Codex redemption uses only the account method and validates all responses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nestkit-codex-reset-"));
  const binary = join(directory, "fake-codex");
  const idempotencyKey = randomUUID();
  const signal = new AbortController().signal;
  const responses: Array<
    { outcome: ResetOutcome } | { outcome: string } | { error: string }
  > = [
    { outcome: "reset" },
    { outcome: "alreadyRedeemed" },
    { outcome: "nothingToReset" },
    { outcome: "noCredit" },
    { outcome: "unexpected" },
    { error: "private-token" },
  ];

  try {
    for (const creditId of [undefined, "earliest-credit"]) {
      const attempt: ResetAttempt = { idempotencyKey, creditId };

      for (const response of responses) {
        await writeFile(
          binary,
          `#!${process.execPath}
const rl = require('node:readline').createInterface({ input: process.stdin });
let ready = false;
rl.on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') console.log(JSON.stringify({ id: m.id, result: {} }));
  else if (m.method === 'initialized') ready = true;
  else if (ready && m.method === 'account/rateLimitResetCredit/consume' && JSON.stringify(m.params) === JSON.stringify(${JSON.stringify(attempt)})) {
    const response = ${JSON.stringify(response)};
    console.log(JSON.stringify('error' in response ? { id: m.id, error: response.error } : { id: m.id, result: response }));
  } else process.exit(1);
});
`,
          { mode: 0o700 },
        );

        if ("error" in response) {
          await assert.rejects(
            redeemCodexReset(attempt, signal, binary),
            /^Error: Codex rejected the account request$/,
          );
        } else if (response.outcome === "unexpected") {
          await assert.rejects(
            redeemCodexReset(attempt, signal, binary),
            /Invalid option/,
          );
        } else {
          assert.deepEqual(
            await redeemCodexReset(attempt, signal, binary),
            response,
          );
        }
      }
    }

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      redeemCodexReset({ idempotencyKey }, controller.signal, binary),
      /Cancelled/,
    );
    await assert.rejects(
      redeemCodexReset({ idempotencyKey: "" }, signal, binary),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
