import { createReadStream } from "node:fs";
import * as zlib from "node:zlib";

/** Read plain or Zstandard JSONL without materializing or changing source logs. */
export async function* readHistoryLines(
  path: string,
  {
    signal,
    maxBytes,
    onBytesRead,
  }: {
    signal: AbortSignal;
    maxBytes: number;
    onBytesRead(size: number): void;
  },
): AsyncGenerator<string> {
  const compressed = path.endsWith(".jsonl.zst");

  if (compressed && typeof zlib.createZstdDecompress !== "function") {
    throw new Error("Compressed history requires Node 22.15 or later");
  }

  const decoder = compressed ? zlib.createZstdDecompress() : undefined;
  const source = createReadStream(path, { signal });
  const input = decoder ?? source;
  let bytes = 0;
  let buffer = "";

  if (decoder) {
    // Pipe does not forward source errors to the decoder's async iterator.
    source.on("error", (error) => decoder.destroy(error));
    source.pipe(decoder);
  }

  input.setEncoding("utf8");

  try {
    for await (const value of input) {
      const chunk: unknown = value;

      if (typeof chunk !== "string") {
        throw new Error("Invalid history stream");
      }

      const size = Buffer.byteLength(chunk);
      bytes += size;
      onBytesRead(size);

      if (bytes > maxBytes) {
        throw new Error("History scan limit reached");
      }

      buffer += chunk;
      let newline: number;

      while ((newline = buffer.indexOf("\n")) !== -1) {
        yield buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
      }
    }

    if (buffer) {
      yield buffer;
    }
  } finally {
    source.destroy();
    decoder?.destroy();
  }
}
