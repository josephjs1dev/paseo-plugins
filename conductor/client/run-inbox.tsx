import { Text, View } from "react-native";
import type { PluginTheme, RpcOutput } from "@getpaseo/plugin";
import type { getRunAccess, listRuns } from "../shared/run-rpc";
import {
  type RunContext,
  type RunSummary,
  type StoredRun,
} from "../shared/run-models";
import type { InboxSession, ViewState } from "./session";
import { Notice } from "./controls";
import { RunRow } from "./run-row";
import { RunDetail } from "./run-detail";

export interface RunInboxData {
  access: RpcOutput<typeof getRunAccess> | undefined;
  list: RpcOutput<typeof listRuns> | undefined;
  loading: boolean;
  stale: boolean;
  detail: { run: StoredRun; context: RunContext } | undefined;
  detailStale: boolean;
}

export function visibleRuns(
  runs: RunSummary[],
  state: ViewState,
  workspaceId?: string,
) {
  const query = state.runQuery.toLowerCase().trim();
  return runs.filter(
    (run) =>
      !["draft", "accepted"].includes(run.status) &&
      (!workspaceId || run.source.workspaceId === workspaceId) &&
      (state.runFilter === "all" ||
        (state.runFilter === "active" &&
          ["planning", "ready", "running"].includes(run.status)) ||
        (state.runFilter === "blocked" &&
          ["blocked", "failed"].includes(run.status)) ||
        run.status === state.runFilter) &&
      [run.title, run.source.workspaceName, run.source.agentId ?? ""].some(
        (value) => value.toLowerCase().includes(query),
      ),
  );
}

export function RunRows({
  theme,
  data,
  state,
  session,
  workspaceId,
  now,
}: {
  theme: PluginTheme;
  data: RunInboxData;
  state: ViewState;
  session: InboxSession;
  workspaceId?: string;
  now: number;
}) {
  const runs = visibleRuns(data.list?.runs ?? [], state, workspaceId);
  const filtered = Boolean(state.runQuery || state.runFilter !== "all");
  return (
    <View style={{ gap: 18 }}>
      {data.access && !data.access.available && (
        <Notice theme={theme} warning>
          {data.access.message ??
            "Agent commands are unavailable on this host."}
        </Notice>
      )}
      {data.loading && <Notice theme={theme}>Loading performances…</Notice>}
      {data.stale && (
        <Notice theme={theme} warning>
          Performance storage could not refresh. Showing last known
          performances; native requests are independent.
        </Notice>
      )}
      {Boolean(data.list?.unavailable || data.list?.incomplete) && (
        <Notice theme={theme} warning>
          Performance coverage is incomplete. {data.list?.unavailable ?? 0}{" "}
          records could not be read. Other performances and native requests
          remain accessible.
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
            {filtered ? "No matching performances" : "No performances yet"}
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
              : "Ask your agent to track the work in Conductor. It will create the performance and report progress."}
          </Text>
        </View>
      )}
      <View style={{ gap: 6 }}>
        {runs.map((run) => (
          <RunRow
            key={run.id}
            run={run}
            theme={theme}
            now={now}
            selected={state.runSelection?.id === run.id}
            onSelect={() =>
              session.update({
                section: "runs",
                runSelection: { kind: "run", id: run.id },
              })
            }
          />
        ))}
      </View>
    </View>
  );
}

export function RunSelectionDetail({
  theme,
  data,
  state,
  compact = false,
  openAgent,
  deleteRun,
}: {
  theme: PluginTheme;
  data: RunInboxData;
  state: ViewState;
  /** Layout hint from the browser; defaults only for callers without layout info. */
  compact?: boolean;
  openAgent?: (id: string) => void;
  deleteRun?: (run: StoredRun) => Promise<void>;
}) {
  const selection = state.runSelection;
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
            ? "This performance could not be read. Refresh or choose another item; native requests remain available."
            : "Loading performance history…"}
        </Notice>
      </View>
    );
  }
  return (
    <RunDetail
      key={selection.id}
      theme={theme}
      run={data.detail.run}
      context={data.detail.context}
      stale={data.detailStale}
      compact={compact}
      {...(openAgent ? { openAgent } : {})}
      {...(deleteRun ? { deleteRun } : {})}
    />
  );
}
