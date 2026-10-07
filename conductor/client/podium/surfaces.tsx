import { useEffect, useState, useSyncExternalStore } from "react";
import { Text } from "react-native";
import {
  useRpc,
  type PluginSurfaceProps,
  type PluginScreenProps,
  type PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
// Namespace import permits loading on 0.10, whose UI module has no SidebarRow.
// InboxSidebar is registered only when the 0.11 sidebar API is present.
import * as PluginUi from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { annotate, answerRequest, archiveAgent } from "../../shared/agents/rpc";
import { isSnoozed, needsAttention } from "../../shared/agents/inbox";
import type { StoredRun } from "../../shared/concerts/models";
import { InboxView } from "./view";
import { InboxSession } from "./session";
import { inboxKey, useInbox } from "../agents/query";
import { useRuns } from "../concerts/query";

export class Sessions {
  private readonly entries = new Map<
    string,
    {
      session: InboxSession;
      scroll: { offset: number };
      workspaceId: string | undefined;
    }
  >();
  get(hostId: string, workspaceId?: string) {
    const key = JSON.stringify([hostId, workspaceId ?? null]);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        session: new InboxSession(),
        scroll: { offset: 0 },
        workspaceId,
      };
      this.entries.set(key, entry);
    }
    return entry;
  }
  clear() {
    for (const { session } of this.entries.values()) {
      session.clear();
    }
    this.entries.clear();
  }
}
export function useClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(interval);
  }, []);
  return now;
}
export function InboxSurface(
  props: PluginSurfaceProps & {
    sessions: Sessions;
    workspaceId?: string;
    params?: PluginScreenProps["params"];
  },
) {
  const query = useInbox(props.host.id);
  const cache = useQueryClient();
  const send = useRpc(answerRequest);
  const change = useRpc(annotate);
  const archive = useRpc(archiveAgent);
  const now = useClock();
  const { session, scroll } = props.sessions.get(
    props.host.id,
    props.workspaceId,
  );
  const initialRun = props.params?.runId;
  const initialSection = props.params?.section;
  useEffect(() => {
    if (initialSection === "runs" && typeof initialRun !== "string") {
      session.update({ section: "runs", runSelection: null });
    }
    if (typeof initialRun === "string") {
      session.update({
        section: "runs",
        runSelection: { kind: "run", id: initialRun },
      });
    }
  }, [initialRun, initialSection, session]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const runs = useRuns(props.host.id, props.workspaceId, state.runSelection);
  const refresh = async () => {
    await cache.invalidateQueries({ queryKey: inboxKey(props.host.id) });
  };
  return (
    <InboxView
      theme={props.theme}
      hostLabel={props.host.label}
      compact={props.layout.compact}
      {...(props.workspaceId ? { workspaceId: props.workspaceId } : {})}
      data={query.data}
      deleteRun={async (run: StoredRun) => {
        await runs.remove(run.id, run.version);
        // Only reached on success: drop the selection so the detail closes.
        session.update({ runSelection: null });
      }}
      runs={{
        access: runs.access.data,
        list: runs.summaries.data,
        loading: runs.summaries.isPending,
        stale: runs.summaries.isError,
        detail: runs.detail.data,
        detailStale: runs.detail.isError,
      }}
      loading={query.isPending}
      refreshing={
        state.section === "runs"
          ? runs.summaries.isFetching || runs.detail.isFetching
          : query.isFetching
      }
      stale={query.isError}
      now={now}
      session={session}
      scroll={scroll}
      refresh={() => {
        const work = state.section === "runs" ? runs.refresh() : refresh();
        work.catch(() => undefined);
      }}
      actions={{
        canNavigate: Boolean(props.navigation),
        openAgent: (agentId) =>
          props.navigation?.openAgent({ agentId, serverId: props.host.id }),
        async answer(item, decision) {
          if (!item.requestId) {
            return;
          }
          session.notice(item.key, "sending");
          try {
            const result = await send({
              key: item.key,
              agentId: item.agentId,
              requestId: item.requestId,
              decision,
            });
            session.notice(item.key, result.status);
          } catch {
            session.notice(item.key, "unknown");
          }
          await refresh();
        },
        async snooze(item, minutes) {
          await change({ kind: "snooze", key: item.key, minutes });
          await refresh();
        },
        async mark(item) {
          await change({
            kind: "mark",
            agentId: item.agentId,
            marked: !item.marked,
          });
          await refresh();
        },
        async archive(item) {
          if (!item.archiveKey) {
            return { status: "stale" };
          }
          const result = await archive({
            agentId: item.agentId,
            key: item.archiveKey,
          });
          if (result.status === "archived") {
            session.update({ selectedKey: null });
          }
          await refresh();
          return result;
        },
      }}
    />
  );
}
export function InboxSidebar(props: PluginSidebarItemProps) {
  const query = useInbox(props.host.id);
  const now = useClock();
  const count =
    query.data?.items.filter(
      (item) => needsAttention(item) && !isSnoozed(item, now),
    ).length ?? 0;
  const reliable = query.data && !query.isError;
  return (
    <PluginUi.SidebarRow
      icon="Workflow"
      label="Conductor"
      active={props.currentScreen?.screenId === "inbox"}
      onPress={() => props.openScreen({ screenId: "inbox" })}
      trailing={
        <Text
          accessibilityLabel={
            reliable ? `${count} need attention` : "Attention count unavailable"
          }
          style={{ color: props.theme.colors.foregroundMuted, fontSize: 12 }}
        >
          {reliable ? `${count}${query.data.incomplete ? "+" : ""}` : "—"}
        </Text>
      }
    />
  );
}
