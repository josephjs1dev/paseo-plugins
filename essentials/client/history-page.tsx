import { useEffect, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useWorkspace,
  type PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { ScrollView, Text, View } from "react-native";
import { providerDefinitions, providerIds } from "../shared/providers";
import type { HistoryNavigation, HistorySelection } from "./history-navigation";
import {
  HistoryAction,
  HistoryChoice,
  HistoryOptions,
  HistorySection,
} from "./history-controls";
import { ModelUsage, HistorySessions } from "./history";
import { UsageSummary } from "./history-totals";
import { HistoryChart } from "./history-chart";
import { useHistoryQuery } from "./history-query";
import { CODEX_CREDIT_RATE_DATE } from "../shared/codex-credit-estimate";
import {
  historyQueryOptions,
  validSessionOffset,
} from "./history-query-options";

type HistoryPageProps = PluginWorkspacePanelProps & {
  historyNavigation: HistoryNavigation;
};

export function UsageHistoryPage(props: HistoryPageProps) {
  const { workspaceId, host, historyNavigation } = props;
  const selection = useSyncExternalStore(historyNavigation.subscribe, () =>
    historyNavigation.getSnapshot(workspaceId),
  );
  const { filterKey } = historyQueryOptions(
    host.id,
    workspaceId,
    selection.provider,
    selection.days,
    0,
    selection.scope,
  );

  return (
    <HistoryResults
      key={JSON.stringify(filterKey)}
      {...props}
      selection={selection}
    />
  );
}

function HistoryResults({
  theme,
  layout,
  host,
  workspaceId,
  historyNavigation,
  selection,
}: HistoryPageProps & { selection: HistorySelection }) {
  const workspaceName = useWorkspace(
    workspaceId,
    (workspace) => workspace.name,
  );
  const { days, provider, scope } = selection;
  const [compact, setCompact] = useState(layout.compact);
  const [sessionOffset, setSessionOffset] = useState(0);
  const [metric, setMetric] = useState<"tokens" | "cost" | "credits">(
    provider === "codex" ? "credits" : "tokens",
  );
  const queryClient = useQueryClient();
  const query = useHistoryQuery(
    host.id,
    workspaceId,
    provider,
    days,
    sessionOffset,
    scope,
  );
  const data = query.data;
  const refreshing = query.isFetching || (data?.refreshing ?? false);
  useEffect(() => {
    if (data) {
      const offset = validSessionOffset(sessionOffset, data.sessionCount);

      if (offset !== sessionOffset) {
        // The destination page may still be fresh in the cache from earlier browsing.
        void queryClient.invalidateQueries({
          queryKey: historyQueryOptions(
            host.id,
            workspaceId,
            provider,
            days,
            offset,
            scope,
          ).queryKey,
          exact: true,
        });
        setSessionOffset(offset);
      }
    }
  }, [
    data,
    sessionOffset,
    queryClient,
    host.id,
    workspaceId,
    provider,
    days,
    scope,
  ]);
  const scopeLabel =
    scope === "workspace"
      ? "This workspace"
      : "All workspaces on " + host.label;
  const periodLabel = scopeLabel + " · " + days + " days";
  const totals = scope === "workspace" ? data?.workspaceTotals : data?.totals;
  const daily = scope === "workspace" ? data?.workspaceDaily : data?.daily;
  const hasCost = daily?.some((day) => day.totals.cost !== null) ?? false;
  const activeMetric = metric === "cost" && !hasCost ? "tokens" : metric;
  const select = (next: Partial<typeof selection>) =>
    historyNavigation.select(workspaceId, { ...selection, ...next });
  const { colors } = theme;

  return (
    <View
      style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface0 }}
      onLayout={(event) => setCompact(event.nativeEvent.layout.width < 700)}
    >
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: compact ? 16 : 32 }}
      >
        <View
          style={{
            width: "100%",
            maxWidth: 1040,
            alignSelf: "center",
            gap: 32,
          }}
        >
          <View style={{ gap: 20 }}>
            <View style={{ gap: 6 }}>
              <Text
                accessibilityRole="header"
                style={{
                  color: colors.foreground,
                  fontSize: 24,
                  lineHeight: 32,
                  fontWeight: "600",
                }}
              >
                Usage history
              </Text>
              <Text
                style={{
                  color: colors.foregroundMuted,
                  fontSize: 13,
                  lineHeight: 20,
                }}
              >
                {workspaceName ?? "This workspace"} · {host.label}
              </Text>
            </View>
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 12,
              }}
            >
              <HistoryOptions theme={theme} label="Provider">
                {providerIds.map((id) => (
                  <HistoryChoice
                    key={id}
                    theme={theme}
                    selected={provider === id}
                    onPress={() => select({ provider: id })}
                  >
                    {providerDefinitions[id].name}
                  </HistoryChoice>
                ))}
              </HistoryOptions>
            </View>
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 12,
              }}
            >
              <HistoryOptions theme={theme} label="History scope">
                <HistoryChoice
                  theme={theme}
                  selected={scope === "workspace"}
                  onPress={() => select({ scope: "workspace" })}
                >
                  This workspace
                </HistoryChoice>
                <HistoryChoice
                  theme={theme}
                  selected={scope === "host"}
                  onPress={() => select({ scope: "host" })}
                >
                  All workspaces
                </HistoryChoice>
              </HistoryOptions>
              <HistoryOptions theme={theme} label="Time period">
                {([7, 30] as const).map((range) => (
                  <HistoryChoice
                    key={range}
                    theme={theme}
                    selected={days === range}
                    onPress={() => select({ days: range })}
                  >
                    {range + "d"}
                  </HistoryChoice>
                ))}
              </HistoryOptions>
              <HistoryAction
                theme={theme}
                disabled={refreshing}
                onPress={() => {
                  void query.refresh();
                }}
              >
                {refreshing ? "Refreshing…" : "Refresh"}
              </HistoryAction>
            </View>
          </View>
          {query.isPending && (
            <Text
              accessibilityRole="alert"
              style={{
                color: colors.foregroundMuted,
                fontSize: 14,
                lineHeight: 22,
              }}
            >
              Loading usage history…
            </Text>
          )}
          {query.isError && (
            <Text
              accessibilityRole="alert"
              style={{
                color: colors.statusDanger,
                fontSize: 13,
                lineHeight: 20,
              }}
            >
              History could not be refreshed. Use Refresh to try again.
            </Text>
          )}
          {data?.warning && (
            <Text
              accessibilityRole="alert"
              style={{ color: colors.foreground, fontSize: 13, lineHeight: 20 }}
            >
              History may be incomplete. Showing available and previously saved
              usage.
            </Text>
          )}
          {data && totals && (
            <>
              <UsageSummary
                theme={theme}
                totals={totals}
                compact={compact}
                showCredits={provider === "codex"}
              />
              <HistorySection
                theme={theme}
                title="Activity"
                description={periodLabel}
                trailing={
                  hasCost || provider === "codex" ? (
                    <HistoryOptions theme={theme} label="Chart metric">
                      <HistoryChoice
                        theme={theme}
                        selected={activeMetric === "tokens"}
                        onPress={() => setMetric("tokens")}
                      >
                        Tokens
                      </HistoryChoice>
                      {provider === "codex" && (
                        <HistoryChoice
                          theme={theme}
                          selected={activeMetric === "credits"}
                          onPress={() => setMetric("credits")}
                        >
                          Estimated credits
                        </HistoryChoice>
                      )}
                      {hasCost && (
                        <HistoryChoice
                          theme={theme}
                          selected={activeMetric === "cost"}
                          onPress={() => setMetric("cost")}
                        >
                          Estimated cost
                        </HistoryChoice>
                      )}
                    </HistoryOptions>
                  ) : undefined
                }
              >
                <HistoryChart
                  theme={theme}
                  data={data}
                  days={days}
                  scope={scope}
                  metric={activeMetric}
                  compact={compact}
                />
              </HistorySection>
              <HistorySection
                theme={theme}
                title="Models"
                description={
                  periodLabel + " · " + data.sessionCount + " sessions"
                }
              >
                <ModelUsage
                  theme={theme}
                  models={data.models}
                  compact={compact}
                  emptyMessage={"No model usage recorded. " + periodLabel + "."}
                />
              </HistorySection>
              <HistorySessions
                theme={theme}
                sessions={data.sessions}
                sessionCount={data.sessionCount}
                scopeLabel={periodLabel}
                showDirectory={scope === "host"}
                sessionOffset={sessionOffset}
                onPageChange={setSessionOffset}
              />
              <Text
                style={{
                  color: colors.foregroundMuted,
                  fontSize: 12,
                  lineHeight: 20,
                }}
              >
                Times are grouped by UTC day. History is retained for 90 days.{" "}
                {provider === "codex"
                  ? "Credit estimates use Standard model rates checked " +
                    CODEX_CREDIT_RATE_DATE +
                    ". Speed and plan adjustments are excluded. Partial estimates cover priced models only; they are not billed charges. "
                  : ""}
                {hasCost
                  ? "Estimated costs use recorded model prices and may differ from your subscription bill."
                  : ""}
              </Text>
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
