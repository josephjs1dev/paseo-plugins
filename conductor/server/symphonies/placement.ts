import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type {
  Score,
  SymphonyPlacement,
  SymphonySource,
} from "../../shared/symphonies/models";
import type { SymphonyHost } from "./host";
import { contentHash } from "./store";
import { missing } from "../files";
import { SymphonyError } from "./errors";

const execute = promisify(execFile);
export interface SymphonyPlacementRuntime {
  capture(source: SymphonySource): Promise<SymphonyPlacement>;
  validate(source: SymphonyPlacement, score: Score): Promise<void>;
}

/** Reject symlinks in every scope component, including existing parents of new files. */
export async function validateSymphonyScopes(
  checkout: string,
  score: Score,
): Promise<void> {
  if ((await realpath(checkout)) !== checkout) {
    throw new SymphonyError(
      "The checkout location changed. Prepare a new symphony.",
    );
  }
  for (const scope of new Set(
    score.tasks.flatMap((task) => [...task.reads, ...task.writes]),
  )) {
    const candidate = join(checkout, scope);
    const child = relative(checkout, candidate);
    if (isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`)) {
      throw new SymphonyError("Task scope leaves the selected checkout.");
    }
    let current = checkout;
    for (const part of child.split(sep).filter(Boolean)) {
      current = join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw new SymphonyError("Task scopes cannot include symbolic links.");
        }
      } catch (error) {
        if (!missing(error)) {
          throw error;
        }
      }
    }
  }
}

export function symphonyPlacement(
  host: SymphonyHost,
): SymphonyPlacementRuntime {
  const concert = async (source: SymphonySource) => {
    const value = await host.concert(source.concertId);
    if (!value?.directory) {
      throw new SymphonyError("The selected concert is unavailable.");
    }
    const checkout = await realpath(value.directory);
    if (source.agentId) {
      const agent = await host.agent(source.agentId);
      if (
        !agent ||
        agent.concertId !== source.concertId ||
        (await realpath(agent.cwd)) !== checkout
      ) {
        throw new SymphonyError(
          "The source agent no longer belongs to this checkout.",
        );
      }
    }
    return { value, checkout };
  };
  return {
    async capture(source) {
      const { value, checkout } = await concert(source);
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
        /* Non-Git checkouts and oversized observations remain explicitly unknown. */
      }
      return {
        ...source,
        concertName: value.name || source.concertId,
        checkout,
        branch,
        base,
        dirtyFingerprint,
      };
    },
    async validate(source, score) {
      const current = await concert(source);
      if (current.checkout !== source.checkout) {
        throw new SymphonyError(
          "The concert moved. Prepare a new symphony in its current checkout.",
        );
      }
      await validateSymphonyScopes(source.checkout, score);
    },
  };
}
