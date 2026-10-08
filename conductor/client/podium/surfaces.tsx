import { useEffect, useState, useSyncExternalStore } from "react";
import { Text } from "react-native";
import {
  useRpc,
  type PluginSurfaceProps,
  type PluginScreenProps,
  type PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
// Namespace import permits loading on 0.10, whose UI module has no SidebarRow.
// PodiumSidebar is registered only when the 0.11 sidebar API is present.
import * as PluginUi from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { annotate, answerRequest, archiveAgent } from "../../shared/agents/rpc";
import { isSnoozed, needsAttention } from "../../shared/agents/attention";
import type { StoredSymphony } from "../../shared/symphonies/models";
import { PodiumView } from "./view";
import { PodiumSession } from "./session";
import { agentsQueryKey, useAgents } from "../agents/query";
import { useSymphonies } from "../symphonies/query";

export class Sessions {
  private readonly entries = new Map<
    string,
    {
      session: PodiumSession;
      scroll: { offset: number };
      concertId: string | undefined;
    }
  >();
  get(hostId: string, concertId?: string) {
    const key = JSON.stringify([hostId, concertId ?? null]);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        session: new PodiumSession(),
        scroll: { offset: 0 },
        concertId,
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
export function PodiumSurface(
  props: PluginSurfaceProps & {
    sessions: Sessions;
    /** A Paseo workspace id from the host, taken in as Conductor's concertId. */
    workspaceId?: string;
    params?: PluginScreenProps["params"];
  },
) {
  const concertId = props.workspaceId;
  const query = useAgents(props.host.id);
  const cache = useQueryClient();
  const send = useRpc(answerRequest);
  const change = useRpc(annotate);
  const archive = useRpc(archiveAgent);
  const now = useClock();
  const { session, scroll } = props.sessions.get(props.host.id, concertId);
  const initialSymphony = props.params?.symphonyId;
  const initialSection = props.params?.section;
  useEffect(() => {
    if (
      initialSection === "symphonies" &&
      typeof initialSymphony !== "string"
    ) {
      session.update({ section: "symphonies", symphonySelection: null });
    }
    if (typeof initialSymphony === "string") {
      session.update({
        section: "symphonies",
        symphonySelection: { kind: "symphony", id: initialSymphony },
      });
    }
  }, [initialSymphony, initialSection, session]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const symphonies = useSymphonies(
    props.host.id,
    concertId,
    state.symphonySelection,
  );
  const refresh = async () => {
    await cache.invalidateQueries({ queryKey: agentsQueryKey(props.host.id) });
  };
  return (
    <PodiumView
      theme={props.theme}
      hostLabel={props.host.label}
      compact={props.layout.compact}
      {...(concertId ? { concertId } : {})}
      data={query.data}
      deleteSymphony={async (symphony: StoredSymphony) => {
        await symphonies.remove(symphony.id, symphony.version);
        // Only reached on success: drop the selection so the detail closes.
        session.update({ symphonySelection: null });
      }}
      symphonies={{
        access: symphonies.access.data,
        list: symphonies.summaries.data,
        loading: symphonies.summaries.isPending,
        stale: symphonies.summaries.isError,
        detail: symphonies.detail.data,
        detailStale: symphonies.detail.isError,
      }}
      loading={query.isPending}
      refreshing={
        state.section === "symphonies"
          ? symphonies.summaries.isFetching || symphonies.detail.isFetching
          : query.isFetching
      }
      stale={query.isError}
      now={now}
      session={session}
      scroll={scroll}
      refresh={() => {
        const work =
          state.section === "symphonies" ? symphonies.refresh() : refresh();
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
export function PodiumSidebar(props: PluginSidebarItemProps) {
  const query = useAgents(props.host.id);
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
      active={props.currentScreen?.screenId === "podium"}
      onPress={() => props.openScreen({ screenId: "podium" })}
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
