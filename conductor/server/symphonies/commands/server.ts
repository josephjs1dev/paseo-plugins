import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { SYMPHONY_COMMAND_SOURCE } from "./source";
import { SymphonyError } from "../errors";
import { ensureSymphonyDirectory, writeSymphonyFile } from "../files";

export interface SymphonyCommandAccess {
  available: boolean;
  commandPath: string | null;
  socketPath: string | null;
  message: string | null;
}

export async function commandServer(
  directory: string,
  execute: (input: unknown) => Promise<unknown>,
) {
  const socketPath = join(directory, "commands.sock");
  const commandPath = join(directory, "command.mjs");
  const unavailable = (message: string) => ({
    access: {
      available: false,
      commandPath: null,
      socketPath: null,
      message,
    } satisfies SymphonyCommandAccess,
    close: () => Promise.resolve(),
  });
  if (process.platform === "win32" || Buffer.byteLength(socketPath) > 100) {
    return unavailable(
      "Agent commands need a local Unix socket path shorter than 100 bytes on this host.",
    );
  }
  await ensureSymphonyDirectory(directory);
  await chmod(directory, 0o700);
  const respond = (
    response: ServerResponse,
    status: number,
    value: unknown,
  ) => {
    if (response.destroyed || response.writableEnded) {
      return;
    }
    let body = JSON.stringify(value);
    if (Buffer.byteLength(body) > 2_200_000) {
      body = JSON.stringify({
        error: "The response exceeds the command size limit.",
      });
      status = 413;
    }
    response.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(body);
  };
  let inFlight = 0;
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (
      request.method !== "POST" ||
      request.url !== "/command" ||
      request.headers.origin ||
      request.headers["content-type"] !== "application/json"
    ) {
      respond(response, 400, {
        error: "Use the Conductor agent command client.",
      });
      return;
    }
    if (inFlight >= 16) {
      respond(response, 429, {
        error:
          "Conductor has too many pending commands. Inspect the symphony before retrying.",
      });
      return;
    }
    inFlight++;
    const timer = setTimeout(
      () =>
        respond(response, 504, {
          error:
            "Command acknowledgement is uncertain. Inspect the symphony before retrying with the same identity.",
        }),
      12_000,
    );
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(String(chunk));
        bytes += buffer.length;
        if (bytes > 262144) {
          respond(response, 413, { error: "Command exceeds 256 KiB." });
          request.resume();
          return;
        }
        chunks.push(buffer);
      }
      let input: unknown;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      } catch {
        throw new SymphonyError("Command input must be valid JSON.");
      }
      if (!response.writableEnded) {
        respond(response, 200, await execute(input));
      }
    } catch (error) {
      let message =
        "The command could not be checked or saved. Inspect the symphony before retrying.";
      if (error instanceof SymphonyError) {
        message = error.message;
      }
      if (error instanceof z.ZodError) {
        message =
          "Invalid command fields. Run command help for the supported format.";
      }
      respond(response, 400, { error: message });
    } finally {
      clearTimeout(timer);
      inFlight--;
    }
  };
  const server = createServer((request, response) => {
    handle(request, response).catch(() =>
      respond(response, 500, { error: "Command service failed." }),
    );
  });
  server.requestTimeout = 12_000;
  server.maxConnections = 32;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch {
    return unavailable(
      "The Conductor command socket is already owned or needs manual recovery. Do not remove it while another plugin process may be running.",
    );
  }
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  try {
    await chmod(socketPath, 0o600);
    await writeSymphonyFile(commandPath, SYMPHONY_COMMAND_SOURCE);
  } catch (error) {
    await close();
    throw error;
  }
  return {
    access: {
      available: true,
      commandPath,
      socketPath,
      message: null,
    } satisfies SymphonyCommandAccess,
    close,
  };
}
