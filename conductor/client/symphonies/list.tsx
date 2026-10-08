import { Text, View } from "react-native";
import type { PluginTheme, RpcOutput } from "@getpaseo/plugin";
import type {
  getSymphonyAccess,
  listSymphonies,
} from "../../shared/symphonies/rpc";
import {
  type SymphonyContext,
  type SymphonySummary,
  type StoredSymphony,
} from "../../shared/symphonies/models";
import type { PodiumSession, ViewState } from "../podium/session";
import { Notice } from "../ui/controls";
import { SymphonyRow } from "./row";
import { SymphonyDetail } from "./detail";

export interface SymphoniesData {
  access: RpcOutput<typeof getSymphonyAccess> | undefined;
  list: RpcOutput<typeof listSymphonies> | undefined;
  loading: boolean;
  stale: boolean;
  detail: { symphony: StoredSymphony; context: SymphonyContext } | undefined;
  detailStale: boolean;
}

export function visibleSymphonies(
  symphonies: SymphonySummary[],
  state: ViewState,
  concertId?: string,
) {
  const query = state.symphonyQuery.toLowerCase().trim();
  return symphonies.filter(
    (symphony) =>
      (!concertId || symphony.source.concertId === concertId) &&
      (state.symphonyFilter === "all" ||
        (state.symphonyFilter === "active" &&
          ["planning", "ready", "running"].includes(symphony.status)) ||
        (state.symphonyFilter === "blocked" &&
          ["blocked", "failed"].includes(symphony.status)) ||
        symphony.status === state.symphonyFilter) &&
      [
        symphony.title,
        symphony.source.concertName,
        symphony.source.agentId ?? "",
      ].some((value) => value.toLowerCase().includes(query)),
  );
}

export function SymphonyRows({
  theme,
  data,
  state,
  session,
  concertId,
  now,
}: {
  theme: PluginTheme;
  data: SymphoniesData;
  state: ViewState;
  session: PodiumSession;
  concertId?: string;
  now: number;
}) {
  const symphonies = visibleSymphonies(
    data.list?.symphonies ?? [],
    state,
    concertId,
  );
  const filtered = Boolean(
    state.symphonyQuery || state.symphonyFilter !== "all",
  );
  return (
    <View style={{ gap: 18 }}>
      {data.access && !data.access.available && (
        <Notice theme={theme} warning>
          {data.access.message ??
            "Agent commands are unavailable on this host."}
        </Notice>
      )}
      {data.loading && <Notice theme={theme}>Loading symphonies…</Notice>}
      {data.stale && (
        <Notice theme={theme} warning>
          Symphony storage could not refresh. Showing last known symphonies;
          native requests are independent.
        </Notice>
      )}
      {Boolean(data.list?.unavailable || data.list?.incomplete) && (
        <Notice theme={theme} warning>
          Symphony coverage is incomplete. {data.list?.unavailable ?? 0} records
          could not be read. Other symphonies and native requests remain
          accessible.
        </Notice>
      )}
      {!data.loading && !data.stale && !symphonies.length && (
        <View style={{ padding: 20, gap: 10 }}>
          <Text
            style={{
              color: theme.colors.foreground,
              fontSize: 17,
              fontWeight: "500",
            }}
          >
            {filtered ? "No matching symphonies" : "No symphonies yet"}
          </Text>
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 13,
              lineHeight: 21,
            }}
          >
            {filtered
              ? "Clear your search or choose All."
              : "A symphony is one task orchestration: the Conductor writes a score, splits it into tasks, and dispatches a task agent to each. Ask your agent to track the work in Conductor to create one."}
          </Text>
        </View>
      )}
      <View style={{ gap: 6 }}>
        {symphonies.map((symphony) => (
          <SymphonyRow
            key={symphony.id}
            symphony={symphony}
            theme={theme}
            now={now}
            selected={state.symphonySelection?.id === symphony.id}
            onSelect={() =>
              session.update({
                section: "symphonies",
                symphonySelection: { kind: "symphony", id: symphony.id },
              })
            }
          />
        ))}
      </View>
    </View>
  );
}

export function SymphonySelectionDetail({
  theme,
  data,
  state,
  compact = false,
  openAgent,
  deleteSymphony,
}: {
  theme: PluginTheme;
  data: SymphoniesData;
  state: ViewState;
  /** Layout hint from the browser; defaults only for callers without layout info. */
  compact?: boolean;
  openAgent?: (id: string) => void;
  deleteSymphony?: (symphony: StoredSymphony) => Promise<void>;
}) {
  const selection = state.symphonySelection;
  if (!selection) {
    return null;
  }
  if (!data.detail || data.detail.symphony.id !== selection.id) {
    return (
      <View style={{ padding: 24 }}>
        <Notice theme={theme} warning={data.detailStale}>
          {data.detailStale
            ? "This symphony could not be read. Refresh or choose another item; native requests remain available."
            : "Loading symphony history…"}
        </Notice>
      </View>
    );
  }
  return (
    <SymphonyDetail
      key={selection.id}
      theme={theme}
      symphony={data.detail.symphony}
      context={data.detail.context}
      stale={data.detailStale}
      compact={compact}
      {...(openAgent ? { openAgent } : {})}
      {...(deleteSymphony ? { deleteSymphony } : {})}
    />
  );
}
