import type {
  PluginClientContext,
  PluginButtonRegistration,
} from "@getpaseo/plugin/client";
import { getInbox } from "../shared/rpc";
import { needsAttention, isSnoozed } from "../shared/inbox";
import { observeDirectory } from "./observation";

/** Background contribution lifetime; no surface has to be open for pills to be useful. */
export function contributePills(client: PluginClientContext): () => void {
  const pills = new Map<string, PluginButtonRegistration>();
  let closed = false;
  let pending = false;
  let rerun = false;
  const refresh = async (): Promise<void> => {
    if (closed) {
      return;
    }
    if (pending) {
      rerun = true;
      return;
    }
    pending = true;
    try {
      const result = await client.rpc(getInbox, {
        knownAgentIds: [...pills.keys()].slice(0, 2000),
      });
      if (closed) {
        return;
      }
      const counts = new Map<string, { workspaceId: string; count: number }>();
      for (const item of result.items) {
        if (
          !item.workspaceId ||
          !needsAttention(item) ||
          isSnoozed(item, Date.now())
        ) {
          continue;
        }
        const entry = counts.get(item.agentId) ?? {
          workspaceId: item.workspaceId,
          count: 0,
        };
        entry.count++;
        counts.set(item.agentId, entry);
      }
      for (const [agentId, { workspaceId, count }] of counts) {
        const button = {
          title: "Open Conductor inbox",
          icon: "Workflow",
          label: `${count} need attention`,
          behavior: {
            kind: "action" as const,
            onPress: () => client.openPanel("inbox", { workspaceId }),
          },
        };
        const current = pills.get(agentId);
        if (current) {
          current.update(button);
        } else {
          pills.set(
            agentId,
            client.addComposerPill({
              id: "inbox",
              workspaceId,
              agentId,
              button,
            }),
          );
        }
      }
      for (const [id, pill] of pills) {
        if (!counts.has(id) && !result.incomplete) {
          pill.remove();
          pills.delete(id);
        }
      }
    } catch {
      if (!closed) {
        for (const pill of pills.values()) {
          pill.update({ label: "Inbox · stale" });
        }
      }
    } finally {
      pending = false;
      if (rerun && !closed) {
        rerun = false;
        refresh().catch(() => undefined);
      }
    }
  };
  const stop = observeDirectory(client.paseo, () => {
    refresh().catch(() => undefined);
  });
  const timer = setInterval(() => {
    refresh().catch(() => undefined);
  }, 30_000);
  refresh().catch(() => undefined);
  return () => {
    closed = true;
    clearInterval(timer);
    stop();
    for (const pill of pills.values()) {
      pill.remove();
    }
    pills.clear();
  };
}
