import { readFile, realpath } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { z } from "zod";
import {
  type CliId,
  type CliStatus,
  isNewerStable,
} from "../shared/cli-maintenance";
import { resolveExecutable, run, type Run } from "./cli-process";

const packages: Record<CliId, string[]> = {
  codex: ["@openai/codex"],
  claude: ["@anthropic-ai/claude-code"],
  opencode: ["opencode-ai"],
  pi: ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"],
};
const overrideSchema = z.object({
  command: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type Installation = {
  executable: string;
  resolvedPath: string;
  env: NodeJS.ProcessEnv;
  installed: string;
  packageName: string;
  method: string;
  updater: string | null;
  prefix: string | null;
};

export function parseVersion(output: string): string {
  const version = output.match(
    /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?:\s|$)/,
  )?.[1];

  if (!version) {
    throw new Error("CLI did not report a supported version.");
  }

  return version;
}

export async function inspectInstallation(
  id: CliId,
  override: unknown,
  signal: AbortSignal,
  execute: Run = run,
): Promise<Installation> {
  const config = overrideSchema.parse(override ?? {});
  const env = { ...process.env, ...config.env };

  // A wrapper could select a different runtime. Do not guess which executable it owns.
  if (config.command && config.command.length !== 1) {
    throw new Error(
      "Custom launch wrapper: update this CLI with its installation manager.",
    );
  }

  const executable = await resolveExecutable(config.command?.[0] ?? id, env);
  const resolvedPath = await realpath(executable);
  const installed = parseVersion(
    await execute(executable, ["--version"], env, signal),
  );
  const fallback = packages[id][0];

  if (!fallback) {
    throw new Error("Unknown CLI.");
  }

  const installation: Installation = {
    executable,
    resolvedPath,
    installed,
    env,
    packageName: fallback,
    method: "Manual",
    updater: null,
    prefix: null,
  };

  if (
    id === "codex" &&
    resolvedPath.includes("/packages/standalone/") &&
    (await execute(executable, ["--help"], env, signal)).includes("update")
  ) {
    return { ...installation, method: "Codex installer", updater: executable };
  }

  if (
    id === "pi" &&
    resolvedPath.endsWith("/agent/bin/pi") &&
    (await execute(executable, ["update", "--help"], env, signal)).includes(
      "--self",
    )
  ) {
    return { ...installation, method: "Pi installer", updater: executable };
  }

  // Native installs keep a stable launcher pointing at a versioned binary.
  if (
    id === "claude" &&
    basename(executable) === "claude" &&
    executable !== resolvedPath &&
    resolvedPath.endsWith(`/claude/versions/${installed}`) &&
    /\binstall\b/.test(await execute(executable, ["--help"], env, signal))
  ) {
    return {
      ...installation,
      method: "Claude Code installer",
      updater: executable,
    };
  }

  let directory = dirname(resolvedPath);

  for (let depth = 0; depth < 8; depth++) {
    try {
      const pkg = z
        .object({ name: z.string() })
        .parse(
          JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
        );

      // Current Claude npm releases resolve into a platform-specific optional
      // package; update the parent CLI package, never the binary package alone.
      const claudeBinary =
        id === "claude" &&
        /^@anthropic-ai\/claude-code-(?:darwin-(?:arm64|x64)|linux-(?:arm64|x64)(?:-musl)?|win32-(?:arm64|x64))$/.test(
          pkg.name,
        );

      if (packages[id].includes(pkg.name) || claudeBinary) {
        installation.packageName = claudeBinary ? fallback : pkg.name;
        let modules = dirname(directory);

        if (pkg.name.startsWith("@")) {
          modules = dirname(modules);
        }

        if (
          basename(modules) === "node_modules" &&
          basename(dirname(modules)) === "lib"
        ) {
          const prefix = dirname(dirname(modules));
          const npm = await realpath(join(prefix, "bin", "npm"));
          // Use the Node runtime beside this installation, not a different global npm.
          env.PATH = `${join(prefix, "bin")}:${env.PATH ?? ""}`;
          const root = await execute(
            npm,
            ["root", "--global", "--prefix", prefix],
            env,
            signal,
          );

          if ((await realpath(root)) === (await realpath(modules))) {
            return { ...installation, method: "npm", updater: npm, prefix };
          }
        }

        // npm may nest the binary package inside the main CLI package.
        if (!claudeBinary) {
          break;
        }
      }
    } catch {
      /* Not a recognized npm installation at this level. */
    }

    const parent = dirname(directory);

    if (parent === directory) {
      break;
    }

    directory = parent;
  }

  // OpenCode's standalone installer has a known location and a version-pinned updater.
  if (
    id === "opencode" &&
    basename(dirname(resolvedPath)) === "bin" &&
    basename(dirname(dirname(resolvedPath))) === ".opencode"
  ) {
    return {
      ...installation,
      method: "OpenCode installer",
      updater: executable,
    };
  }

  return installation;
}

export async function latestVersion(
  packageName: string,
  signal: AbortSignal,
): Promise<string> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 15_000);
  signal.addEventListener("abort", abort, { once: true });

  if (signal.aborted) {
    abort();
  }

  try {
    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
      {
        signal: controller.signal,
        redirect: "error",
      },
    );

    if (!response.ok || !response.body) {
      throw new Error("Release registry unavailable.");
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      bytes += value.byteLength;

      if (bytes > 1_048_576) {
        controller.abort();
        throw new Error("Release response too large.");
      }

      chunks.push(value);
    }

    const data = z
      .object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) })
      .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));

    return data.version;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export function describeInstallation(
  id: CliId,
  installation: Installation,
  latest: string | null,
): CliStatus {
  const { installed, executable, method, updater } = installation;
  const newer = latest !== null && isNewerStable(installed, latest);
  let message = "Up to date";

  if (!latest) {
    message = "Could not check the release registry. Try again.";
  } else if (installed.includes("-") || isNewerStable(latest, installed)) {
    message = "Ahead of the stable release; no downgrade offered.";
  } else if (newer) {
    message = updater
      ? "Update available"
      : "Update available. Use the original installation manager.";
  }

  return {
    id,
    installed,
    executable,
    method,
    latest,
    canUpdate: newer && updater !== null,
    message,
  };
}

export async function updateInstallation(
  installation: Installation,
  version: string,
  signal: AbortSignal,
  execute: Run = run,
) {
  if (
    !installation.updater ||
    !isNewerStable(installation.installed, version)
  ) {
    throw new Error("Check for updates again.");
  }

  let args = ["upgrade", version, "--method", "curl"];

  if (installation.method === "npm") {
    args = [
      "install",
      "--global",
      "--prefix",
      installation.prefix ?? "",
      `${installation.packageName}@${version}`,
      "--no-audit",
      "--no-fund",
    ];
  } else if (installation.method === "Codex installer") {
    args = ["update"];
  } else if (installation.method === "Claude Code installer") {
    args = ["install", version];
  } else if (installation.method === "Pi installer") {
    args = ["update", "--self", "--no-approve"];
  }

  await execute(installation.updater, args, installation.env, signal, 180_000);
  const actual = parseVersion(
    await execute(
      installation.executable,
      ["--version"],
      installation.env,
      signal,
    ),
  );

  if (actual !== version && !isNewerStable(version, actual)) {
    throw new Error("The executable did not report the requested version.");
  }
}
