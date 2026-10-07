import { Text, View } from "react-native";
import type { PluginTheme, RpcOutput } from "@getpaseo/plugin";
import type { getConcertAccess, listConcerts } from "../../shared/concerts/rpc";
import {
  type ConcertContext,
  type ConcertSummary,
  type StoredConcert,
} from "../../shared/concerts/models";
import type { PodiumSession, ViewState } from "../podium/session";
import { Notice } from "../ui/controls";
import { ConcertRow } from "./row";
import { ConcertDetail } from "./detail";

export interface ConcertsData {
  access: RpcOutput<typeof getConcertAccess> | undefined;
  list: RpcOutput<typeof listConcerts> | undefined;
  loading: boolean;
  stale: boolean;
  detail: { run: StoredConcert; context: ConcertContext } | undefined;
  detailStale: boolean;
}

export function visibleConcerts(
  runs: ConcertSummary[],
  state: ViewState,
  workspaceId?: string,
) {
  const query = state.concertQuery.toLowerCase().trim();
  return runs.filter(
    (run) =>
      !["draft", "accepted"].includes(run.status) &&
      (!workspaceId || run.source.workspaceId === workspaceId) &&
      (state.concertFilter === "all" ||
        (state.concertFilter === "active" &&
          ["planning", "ready", "running"].includes(run.status)) ||
        (state.concertFilter === "blocked" &&
          ["blocked", "failed"].includes(run.status)) ||
        run.status === state.concertFilter) &&
      [run.title, run.source.workspaceName, run.source.agentId ?? ""].some(
        (value) => value.toLowerCase().includes(query),
      ),
  );
}

export function ConcertRows({
  theme,
  data,
  state,
  session,
  workspaceId,
  now,
}: {
  theme: PluginTheme;
  data: ConcertsData;
  state: ViewState;
  session: PodiumSession;
  workspaceId?: string;
  now: number;
}) {
  const runs = visibleConcerts(data.list?.runs ?? [], state, workspaceId);
  const filtered = Boolean(state.concertQuery || state.concertFilter !== "all");
  return (
    <View style={{ gap: 18 }}>
      {data.access && !data.access.available && (
        <Notice theme={theme} warning>
          {data.access.message ??
            "Agent commands are unavailable on this host."}
        </Notice>
      )}
      {data.loading && <Notice theme={theme}>Loading concerts…</Notice>}
      {data.stale && (
        <Notice theme={theme} warning>
          Concert storage could not refresh. Showing last known concerts; native
          requests are independent.
        </Notice>
      )}
      {Boolean(data.list?.unavailable || data.list?.incomplete) && (
        <Notice theme={theme} warning>
          Concert coverage is incomplete. {data.list?.unavailable ?? 0} records
          could not be read. Other concerts and native requests remain
          accessible.
        </Notice>
      )}
      {!data.loading && !data.stale && !runs.length && (
        <View style={{ padding: 20, gap: 10 }}>
          <Text
            style={{
              color: theme.colors.foreground,
              fontSize: 17,
              fontWeight: "500",
            }}
          >
            {filtered ? "No matching concerts" : "No concerts yet"}
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
              : "Ask your agent to track the work in Conductor. It will create the concert and report progress."}
          </Text>
        </View>
      )}
      <View style={{ gap: 6 }}>
        {runs.map((run) => (
          <ConcertRow
            key={run.id}
            run={run}
            theme={theme}
            now={now}
            selected={state.concertSelection?.id === run.id}
            onSelect={() =>
              session.update({
                section: "concerts",
                concertSelection: { kind: "concert", id: run.id },
              })
            }
          />
        ))}
      </View>
    </View>
  );
}

export function ConcertSelectionDetail({
  theme,
  data,
  state,
  compact = false,
  openAgent,
  deleteConcert,
}: {
  theme: PluginTheme;
  data: ConcertsData;
  state: ViewState;
  /** Layout hint from the browser; defaults only for callers without layout info. */
  compact?: boolean;
  openAgent?: (id: string) => void;
  deleteConcert?: (run: StoredConcert) => Promise<void>;
}) {
  const selection = state.concertSelection;
  if (!selection) {
    return null;
  }
  if (
    !data.detail ||
    data.detail.run.id !== selection.id ||
    !data.detail.run.execution
  ) {
    return (
      <View style={{ padding: 24 }}>
        <Notice theme={theme} warning={data.detailStale}>
          {data.detailStale
            ? "This concert could not be read. Refresh or choose another item; native requests remain available."
            : "Loading concert history…"}
        </Notice>
      </View>
    );
  }
  return (
    <ConcertDetail
      key={selection.id}
      theme={theme}
      run={data.detail.run}
      context={data.detail.context}
      stale={data.detailStale}
      compact={compact}
      {...(openAgent ? { openAgent } : {})}
      {...(deleteConcert ? { deleteConcert } : {})}
    />
  );
}
