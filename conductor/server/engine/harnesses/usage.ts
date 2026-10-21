import type { AttemptUsage } from "../../../shared/symphonies/models";
import { createClaudeReader } from "./claude";
import { createCodexReader } from "./codex";
import { createOpenCodeReader } from "./opencode";
import type { HarnessPathOptions } from "./paths";
import { createPiReader } from "./pi";

export type { AttemptUsage };

/**
 * Sums one harness session's usage entries whose timestamps fall inside the
 * inclusive attempt window. Returns null when the session log is not found.
 */
export interface UsageReader {
  readonly provider: string;
  read(
    sessionId: string,
    from: number,
    to: number,
  ): Promise<AttemptUsage | null>;
}

/** Paseo provider ids with a Conductor-owned session log reader. */
export function readerFor(
  provider: string,
  options: HarnessPathOptions = {},
): UsageReader | undefined {
  switch (provider) {
    case "codex":
      return createCodexReader(options);
    case "claude":
      return createClaudeReader(options);
    case "pi":
      return createPiReader(options);
    case "opencode":
      return createOpenCodeReader(options);
    default:
      return undefined;
  }
}
