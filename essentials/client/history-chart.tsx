import type { PluginHostProps } from "@getpaseo/plugin/client";
import type { History } from "../shared/history";
import {
  bucketLabel,
  compactTokens,
  formatCost,
  historyBuckets,
  totalTokens,
} from "../shared/history-display";
import { Text, View } from "react-native";

export function HistoryChart({
  theme,
  data,
  days,
  scope,
  metric = "tokens",
  compact = false,
}: Pick<PluginHostProps, "theme"> & {
  data: History;
  days: 7 | 30 | 90;
  scope: "workspace" | "host";
  metric?: "tokens" | "cost";
  compact?: boolean;
}) {
  const daily = scope === "workspace" ? data.workspaceDaily : data.daily;
  const buckets = historyBuckets(daily, days, data.periodEnd);
  const amounts = buckets.map((bucket) =>
    metric === "tokens" ? totalTokens(bucket.totals) : bucket.totals.cost,
  );
  const maximum = Math.max(0, ...amounts.map((value) => value ?? 0));
  const interval = {
    7: "Daily totals",
    30: "7-day totals · first period covers 2 days",
    90: "30-day totals",
  }[days];

  return (
    <View style={{ gap: 14 }}>
      {buckets.map((bucket, index) => {
        const amount = amounts[index] ?? null;
        let value =
          metric === "tokens"
            ? compactTokens(totalTokens(bucket.totals))
            : formatCost(bucket.totals.cost);

        if (!bucket.hasUsage) {
          value = "No usage";
        }

        const track = (
          <View
            style={{
              height: 6,
              borderRadius: 3,
              backgroundColor: theme.colors.surface2,
              overflow: "hidden",
            }}
          >
            {bucket.hasUsage && amount !== null && maximum > 0 && (
              <View
                style={{
                  height: 6,
                  borderRadius: 3,
                  width: (String((amount / maximum) * 100) +
                    "%") as `${number}%`,
                  backgroundColor: theme.colors.accent,
                }}
              />
            )}
          </View>
        );

        return (
          <View key={bucket.startDay} style={{ gap: 8 }}>
            <View
              style={{ flexDirection: "row", alignItems: "center", gap: 16 }}
            >
              <Text
                style={{
                  color: theme.colors.foregroundMuted,
                  fontSize: 12,
                  lineHeight: 20,
                  width: compact ? undefined : 148,
                  flex: compact ? 1 : undefined,
                }}
              >
                {bucketLabel(bucket.startDay, bucket.endDay)}
              </Text>
              {!compact && <View style={{ flex: 1 }}>{track}</View>}
              <Text
                selectable
                style={{
                  color: theme.colors.foreground,
                  fontSize: 13,
                  lineHeight: 20,
                  width: 104,
                  textAlign: "right",
                  fontVariant: ["tabular-nums"],
                }}
              >
                {value}
              </Text>
            </View>
            {compact && track}
          </View>
        );
      })}
      <Text
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 11,
          lineHeight: 18,
          marginTop: 2,
        }}
      >
        {interval} · UTC · {metric === "tokens" ? "tokens" : "estimated USD"}
      </Text>
    </View>
  );
}
