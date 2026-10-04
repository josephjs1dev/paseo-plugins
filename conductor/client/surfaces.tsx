import { useEffect, useState } from "react";
import { Text } from "react-native";
import {
  useRpc,
  type PluginSurfaceProps,
  type PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
// Namespace import permits loading on 0.10, whose UI module has no SidebarRow.
// InboxSidebar is registered only when the 0.11 sidebar API is present.
import * as PluginUi from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { annotate, answerRequest, archiveAgent } from "../shared/rpc";
import { isSnoozed, needsAttention } from "../shared/inbox";
import { InboxView } from "./inbox-view";
import { InboxSession } from "./session";
import { inboxKey, useInbox } from "./query";

export class Sessions {
  private readonly entries = new Map<
    string,
    { session: InboxSession; scroll: { offset: number } }
  >();
  get(hostId: string, workspaceId?: string) {
    const key = JSON.stringify([hostId, workspaceId ?? null]);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { session: new InboxSession(), scroll: { offset: 0 } };
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
  props: PluginSurfaceProps & { sessions: Sessions; workspaceId?: string },
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
      loading={query.isPending}
      refreshing={query.isFetching}
      stale={query.isError}
      now={now}
      session={session}
      scroll={scroll}
      refresh={() => {
        refresh().catch(() => undefined);
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
