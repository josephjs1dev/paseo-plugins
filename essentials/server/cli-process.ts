import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export type Run = (
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  timeout?: number,
) => Promise<string>;

export const run: Run = (file, args, env, signal, timeout = 15_000) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Command failed or timed out."));

      return;
    }

    const child = spawn(file, args, {
      env,
      detached: process.platform !== "win32",
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let done = false;
    let bytes = 0;
    let output = "";
    function finish(failed: boolean) {
      if (done) {
        return;
      }

      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);

      if (!failed) {
        resolve(output.trim());

        return;
      }

      // Stop installer children as well as their parent on cancellation/timeout.
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* The process group may already have exited. */
        }
      }

      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      // Never forward process output: package managers can include registry credentials.
      reject(new Error("Command failed or timed out."));
    }

    const stop = () => finish(true);
    const timer = setTimeout(stop, timeout);
    signal.addEventListener("abort", stop, { once: true });

    if (signal.aborted) {
      stop();
    }

    child.once("error", stop);
    child.once("close", (code) => finish(code !== 0));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    function receive(chunk: string, stdout: boolean) {
      if (done) {
        return;
      }

      bytes += Buffer.byteLength(chunk);

      if (bytes > 1_048_576) {
        stop();

        return;
      }

      if (stdout) {
        output += chunk;
      }
    }

    child.stdout.on("data", (chunk: string) => receive(chunk, true));
    child.stderr.on("data", (chunk: string) => receive(chunk, false));
  });

export async function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const paths = isAbsolute(command)
    ? [command]
    : (env.PATH ?? "")
        .split(delimiter)
        .filter((entry) => isAbsolute(entry))
        .map((entry) => join(entry, command));

  for (const path of paths) {
    try {
      await access(path, constants.X_OK);

      return path;
    } catch {
      /* Try the next PATH entry. */
    }
  }

  throw new Error("CLI not found on the host PATH.");
}
