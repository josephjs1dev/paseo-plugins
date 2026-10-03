import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as zlib from "node:zlib";
import { readHistoryLines } from "../../server/history-log";

const hasZstd = typeof zlib.zstdCompressSync === "function";

test("plain and compressed JSONL preserve Unicode, CRLF, and the final partial line", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-history-log-"));
  const contents = 'first é\r\nsecond 東京\n{"partial":';

  try {
    for (const compressed of hasZstd ? [false, true] : [false]) {
      const path = join(directory, compressed ? "log.jsonl.zst" : "log.jsonl");
      const data = compressed ? zlib.zstdCompressSync(contents) : contents;
      await writeFile(path, data);
      const lines: string[] = [];
      let bytes = 0;

      for await (const line of readHistoryLines(path, {
        signal: new AbortController().signal,
        maxBytes: 1024,
        onBytesRead: (size) => {
          bytes += size;
        },
      })) {
        lines.push(line);
      }

      assert.deepEqual(lines, ["first é", "second 東京", '{"partial":']);
      assert.equal(bytes, Buffer.byteLength(contents));
      assert.deepEqual(await readFile(path), Buffer.from(data));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "compressed history bounds expanded bytes rather than compressed file size",
  { skip: !hasZstd },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-history-limit-"));

    try {
      const data = zlib.zstdCompressSync("x".repeat(4096));
      assert.ok(data.length < 128);
      const path = join(directory, "log.jsonl.zst");
      await writeFile(path, data);
      await assert.rejects(async () => {
        for await (const line of readHistoryLines(path, {
          signal: new AbortController().signal,
          maxBytes: 128,
          onBytesRead: () => {},
        })) {
          assert.fail(
            "Oversized history must not yield a line: " + line.length,
          );
        }
      }, /History scan limit reached/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("history stream failures and cancellation reject without returning empty success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-history-errors-"));

  try {
    const path = join(directory, "log.jsonl.zst");
    await writeFile(path, "invalid compressed data");
    const cancelled = new AbortController();
    cancelled.abort();

    for (const [file, signal] of [
      [path, new AbortController().signal],
      [join(directory, "missing.jsonl.zst"), new AbortController().signal],
      [path, cancelled.signal],
    ] as const) {
      await assert.rejects(async () => {
        for await (const line of readHistoryLines(file, {
          signal,
          maxBytes: 1024,
          onBytesRead: () => {},
        })) {
          assert.fail("Failed history must not yield a line: " + line.length);
        }
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
