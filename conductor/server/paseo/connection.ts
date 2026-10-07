import { RunError } from "../concerts/errors";
import type { PaseoApi } from "./types";

/** Holds the latest daemon connection that a handler or hook received. */
export function paseoConnection() {
  let current: PaseoApi | null = null;
  return {
    remember: (paseo: PaseoApi): void => {
      current = paseo;
    },
    get available(): boolean {
      return current !== null;
    },
    require: (): PaseoApi => {
      if (!current) {
        throw new RunError(
          "Conductor needs an agent lifecycle event or an Inbox refresh to obtain its runtime connection. Retry after the source session starts.",
        );
      }
      return current;
    },
  };
}
export type PaseoConnection = ReturnType<typeof paseoConnection>;
