import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readUsage } from "../shared/usage";
import { createUsageReader } from "./usage";
import { readHistory } from "../shared/history";
import { createHistoryStore } from "./history";
import { prepareCodexReset, consumeCodexReset } from "../shared/codex-reset";
import { createCodexResetter } from "./codex-reset";

export default function contribute(server: PluginServerContext) {
  const reader = createUsageReader();
  const resetter = createCodexResetter(reader);
  const history = createHistoryStore();
  server.handle(readUsage, ({ provider }) => reader.read(provider));
  server.handle(prepareCodexReset, () => resetter.prepare());
  server.handle(consumeCodexReset, ({ idempotencyKey, creditId }) =>
    resetter.consume({ idempotencyKey, creditId }),
  );
  server.handle(
    readHistory,
    async (
      { provider, workspaceId, days, sessionOffset, scope },
      { paseo },
    ) => {
      const workspace = await paseo.workspaces.ref(workspaceId).refresh();

      if (!workspace?.workspaceDirectory) {
        throw new Error("Workspace unavailable");
      }

      try {
        return await history.read(
          provider,
          workspace.workspaceDirectory,
          days,
          sessionOffset,
          scope,
        );
      } catch {
        throw new Error(
          "Usage history unavailable. Check the host's storage access and stored data.",
        );
      }
    },
  );

  return () => {
    resetter.close();
    reader.close();
    history.close();
  };
}
