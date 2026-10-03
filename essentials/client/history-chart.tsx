import { useState } from "react";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import type { History } from "../shared/history";
import {
  bucketLabel,
  compactTokens,
  exactTokens,
  formatCost,
  formatCredits,
  formatCreditEstimate,
  historyBuckets,
  totalTokens,
} from "../shared/history-display";
import { Pressable, ScrollView, Text, View } from "react-native";

const CHART_HEIGHT = 180;

export function HistoryChart({
  theme,
  data,
  days,
  scope,
  metric = "tokens",
  compact = false,
}: Pick<PluginHostProps, "theme"> & {
  data: History;
  days: 7 | 30;
  scope: "workspace" | "host";
  metric?: "tokens" | "cost" | "credits";
  compact?: boolean;
}) {
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const { colors } = theme;
  const metricUnit = {
    tokens: "tokens",
    cost: "estimated USD",
    credits: "estimated credits",
  }[metric];
  const daily = scope === "workspace" ? data.workspaceDaily : data.daily;
  const buckets = historyBuckets(daily, days, data.periodEnd);
  const amount = (bucket: (typeof buckets)[number]) => {
    if (metric === "credits") {
      return bucket.totals.creditEstimate?.amount ?? null;
    }

    return metric === "tokens"
      ? totalTokens(bucket.totals)
      : bucket.totals.cost;
  };

  const maximum = Math.max(0, ...buckets.map((bucket) => amount(bucket) ?? 0));
  const scale = maximum || 1;
  const format = (value: number) => {
    if (metric === "credits") {
      return formatCredits(value);
    }

    return metric === "tokens" ? compactTokens(value) : formatCost(value);
  };

  const describe = (bucket: (typeof buckets)[number]) => {
    if (!bucket.hasUsage) {
      return "No usage";
    }

    if (metric === "credits") {
      return (
        formatCreditEstimate(bucket.totals.creditEstimate) +
        (bucket.totals.creditEstimate?.amount != null ? " credits" : "")
      );
    }

    return metric === "tokens"
      ? exactTokens(totalTokens(bucket.totals)) + " tokens"
      : formatCost(bucket.totals.cost);
  };

  const selected =
    buckets.find((bucket) => bucket.startDay === selectedDay) ??
    [...buckets].reverse().find((bucket) => bucket.hasUsage) ??
    buckets[buckets.length - 1];

  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            width: 60,
            height: CHART_HEIGHT,
            justifyContent: "space-between",
          }}
        >
          {[maximum, maximum / 2, 0].map((tick, index) => (
            <Text
              key={index}
              style={{
                color: colors.foregroundMuted,
                fontSize: 11,
                lineHeight: 16,
                textAlign: "right",
                fontVariant: ["tabular-nums"],
              }}
            >
              {format(tick)}
            </Text>
          ))}
        </View>
        <ScrollView
          horizontal
          style={{ flex: 1, minWidth: 0 }}
          contentContainerStyle={{
            flexGrow: 1,
            minWidth: days * (compact ? 36 : 28),
            paddingBottom: 8,
          }}
        >
          <View style={{ flex: 1 }}>
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                height: CHART_HEIGHT,
                justifyContent: "space-between",
              }}
            >
              {[0, 1, 2].map((line) => (
                <View
                  key={line}
                  style={{ height: 1, backgroundColor: colors.border }}
                />
              ))}
            </View>
            <View style={{ flexDirection: "row" }}>
              {buckets.map((bucket, index) => {
                const value = amount(bucket);
                const isSelected = bucket.startDay === selected?.startDay;
                const label =
                  days === 7 || index % 5 === 0 || index === days - 1
                    ? bucket.startDay.slice(8)
                    : "";

                return (
                  <Pressable
                    key={bucket.startDay}
                    accessibilityRole="button"
                    accessibilityLabel={
                      bucket.startDay + ": " + describe(bucket)
                    }
                    accessibilityHint="Show daily total"
                    accessibilityState={{ selected: isSelected }}
                    onPress={() => setSelectedDay(bucket.startDay)}
                    onHoverIn={() => setSelectedDay(bucket.startDay)}
                    onFocus={() => setSelectedDay(bucket.startDay)}
                    style={({ pressed }) => ({
                      flex: 1,
                      minWidth: compact ? 36 : 28,
                      alignItems: "center",
                      paddingHorizontal: 4,
                      gap: 8,
                      borderRadius: 4,
                      backgroundColor:
                        pressed || isSelected ? colors.surface1 : "transparent",
                    })}
                  >
                    <View
                      style={{
                        height: CHART_HEIGHT,
                        width: "100%",
                        alignItems: "center",
                        justifyContent: "flex-end",
                      }}
                    >
                      {bucket.hasUsage && value === null ? (
                        <Text style={{ color: colors.foregroundMuted }}>—</Text>
                      ) : (
                        <View
                          style={{
                            width: "100%",
                            maxWidth: days === 7 ? 44 : 24,
                            height:
                              value !== null && value > 0
                                ? Math.max(2, (value / scale) * CHART_HEIGHT)
                                : 2,
                            borderTopLeftRadius: 3,
                            borderTopRightRadius: 3,
                            backgroundColor:
                              value !== null && value > 0
                                ? colors.accent
                                : colors.border,
                          }}
                        />
                      )}
                    </View>
                    <Text
                      style={{
                        color: isSelected
                          ? colors.foreground
                          : colors.foregroundMuted,
                        fontSize: 11,
                        lineHeight: 16,
                        fontVariant: ["tabular-nums"],
                      }}
                    >
                      {label || " "}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </ScrollView>
      </View>
      {selected && (
        <Text
          selectable
          accessibilityLiveRegion="polite"
          style={{ color: colors.foreground, fontSize: 13, lineHeight: 20 }}
        >
          {bucketLabel(selected.startDay, selected.endDay)} ·{" "}
          {describe(selected)}
        </Text>
      )}
      <Text
        style={{ color: colors.foregroundMuted, fontSize: 11, lineHeight: 18 }}
      >
        {bucketLabel(buckets[0]?.startDay ?? data.periodEnd, data.periodEnd)}
        {" · Daily totals · UTC · "}
        {metricUnit}
        {" · Hover or tap a bar for details"}
      </Text>
    </View>
  );
}
