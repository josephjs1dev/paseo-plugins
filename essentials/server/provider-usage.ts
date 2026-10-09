import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readUsage } from "../shared/usage";
import { createUsageReader } from "./usage";
import { readHistory } from "../shared/history";
import { sessionKey } from "../shared/history-display";
import { createHistoryStore, historyDirectory } from "./history";
import { createWorkspaceSessions } from "./workspace-sessions";
import { prepareCodexReset, consumeCodexReset } from "../shared/codex-reset";
import { createCodexResetter } from "./codex-reset";

const WORKSPACE_WARNING =
  "Could not read Paseo agents. Workspace usage uses previously saved session links.";

export default function contribute(server: PluginServerContext) {
  const reader = createUsageReader();
  const resetter = createCodexResetter(reader);
  const history = createHistoryStore();
  const workspaceSessions = createWorkspaceSessions(historyDirectory());
  server.handle(readUsage, ({ provider, refresh }) =>
    reader.read(provider, refresh),
  );
  server.handle(prepareCodexReset, () => resetter.prepare());
  server.handle(consumeCodexReset, ({ idempotencyKey, creditId }) =>
    resetter.consume({ idempotencyKey, creditId }),
  );
  server.handle(
    readHistory,
    async (
      { provider, workspaceId, days, sessionOffset, scope, refresh },
      { paseo },
    ) => {
      const workspace = await paseo.workspaces.ref(workspaceId).refresh();

      if (!workspace) {
        throw new Error("Workspace unavailable");
      }

      // Workspaces can share a checkout, so attribute by the agents' sessions.
      const attribution = await workspaceSessions.read(
        workspaceId,
        (options) => paseo.agents.list(options),
        refresh ?? false,
      );
      let result;

      try {
        result = await history.read(
          provider,
          (row) => attribution.sessions.has(sessionKey(row)),
          days,
          sessionOffset,
          scope,
          refresh ?? false,
        );
      } catch {
        throw new Error(
          "Usage history unavailable. Check the host's storage access and stored data.",
        );
      }

      return attribution.complete || result.warning
        ? result
        : { ...result, warning: WORKSPACE_WARNING };
    },
  );

  return async () => {
    resetter.close();
    reader.close();
    await history.close();
  };
}
