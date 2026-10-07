import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type {
  RunGraph,
  RunPlacement,
  RunSource,
} from "../../shared/concerts/models";
import type { ConcertHost } from "./host";
import { contentHash } from "./store";
import { missing } from "../files";
import { RunError } from "./errors";

const execute = promisify(execFile);
export interface RunPlacementRuntime {
  capture(source: RunSource): Promise<RunPlacement>;
  validate(source: RunPlacement, graph: RunGraph): Promise<void>;
}

/** Reject symlinks in every scope component, including existing parents of new files. */
export async function validateRunScopes(
  checkout: string,
  graph: RunGraph,
): Promise<void> {
  if ((await realpath(checkout)) !== checkout) {
    throw new RunError("The checkout location changed. Prepare a new concert.");
  }
  for (const scope of new Set(
    graph.tasks.flatMap((task) => [...task.reads, ...task.writes]),
  )) {
    const candidate = join(checkout, scope);
    const child = relative(checkout, candidate);
    if (isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`)) {
      throw new RunError("Task scope leaves the selected checkout.");
    }
    let current = checkout;
    for (const part of child.split(sep).filter(Boolean)) {
      current = join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw new RunError("Task scopes cannot include symbolic links.");
        }
      } catch (error) {
        if (!missing(error)) {
          throw error;
        }
      }
    }
  }
}

export function runPlacement(host: ConcertHost): RunPlacementRuntime {
  const workspace = async (source: RunSource) => {
    const value = await host.workspace(source.workspaceId);
    if (!value?.directory) {
      throw new RunError("The selected workspace is unavailable.");
    }
    const checkout = await realpath(value.directory);
    if (source.agentId) {
      const agent = await host.agent(source.agentId);
      if (
        !agent ||
        agent.workspaceId !== source.workspaceId ||
        (await realpath(agent.cwd)) !== checkout
      ) {
        throw new RunError(
          "The source agent no longer belongs to this checkout.",
        );
      }
    }
    return { value, checkout };
  };
  return {
    async capture(source) {
      const { value, checkout } = await workspace(source);
      const git = async (args: string[]) =>
        (
          await execute("git", ["-c", "core.fsmonitor=false", ...args], {
            cwd: checkout,
            timeout: 5000,
            maxBuffer: 1_000_000,
            env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
          })
        ).stdout;
      let branch: string | null = null;
      let base: string | null = null;
      let dirtyFingerprint: string | null = null;
      try {
        base = (await git(["rev-parse", "--verify", "HEAD"])).trim();
        branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
        const status = await git([
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ]);
        const diff = await git([
          "diff",
          "HEAD",
          "--binary",
          "--no-ext-diff",
          "--no-textconv",
        ]);
        // Captures tracked changes and untracked names only; never authorizes execution.
        dirtyFingerprint = contentHash(JSON.stringify([status, diff]));
      } catch {
        /* Non-Git workspaces and oversized observations remain explicitly unknown. */
      }
      return {
        ...source,
        workspaceName: value.name || source.workspaceId,
        checkout,
        branch,
        base,
        dirtyFingerprint,
      };
    },
    async validate(source, graph) {
      const current = await workspace(source);
      if (current.checkout !== source.checkout) {
        throw new RunError(
          "The workspace moved. Prepare a new concert in its current checkout.",
        );
      }
      await validateRunScopes(source.checkout, graph);
    },
  };
}
