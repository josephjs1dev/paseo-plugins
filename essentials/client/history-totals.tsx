import { useState } from "react";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import type { Totals } from "../shared/history";
import {
  compactTokens,
  exactTokens,
  formatCost,
  formatCreditEstimate,
  formatCredits,
  totalTokens,
} from "../shared/history-display";
import { HistoryValue } from "./history-controls";

type Themed = Pick<PluginHostProps, "theme">;

export function TokenDetails({ theme, totals }: Themed & { totals: Totals }) {
  const cachedShare =
    totals.input > 0 ? ((100 * totals.cached) / totals.input).toFixed(1) : "0";

  return (
    <View style={{ gap: 4 }}>
      <HistoryValue
        theme={theme}
        label="Input"
        value={exactTokens(totals.input)}
      />
      <HistoryValue
        theme={theme}
        nested
        label={"Cached · " + cachedShare + "% of input"}
        value={exactTokens(totals.cached)}
      />
      <HistoryValue
        theme={theme}
        label="Output"
        value={exactTokens(totals.output)}
      />
      <HistoryValue
        theme={theme}
        nested
        label="Reasoning · included in output"
        value={exactTokens(totals.reasoning)}
      />
      <HistoryValue
        theme={theme}
        label="Total tokens"
        value={exactTokens(totalTokens(totals))}
      />
      {totals.cost !== null && (
        <HistoryValue
          theme={theme}
          label="Estimated cost"
          value={formatCost(totals.cost)}
        />
      )}
      {totals.creditEstimate !== undefined && (
        <HistoryValue
          theme={theme}
          label="Estimated credits"
          value={formatCreditEstimate(totals.creditEstimate)}
        />
      )}
    </View>
  );
}

function TokenBreakdown({ theme, totals }: Themed & { totals: Totals }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <View style={{ gap: expanded ? 12 : 0 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={{
          minHeight: 40,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
        }}
      >
        <Icon
          name={expanded ? "ChevronDown" : "ChevronRight"}
          size={14}
          color={theme.colors.foregroundMuted}
        />
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 18,
          }}
        >
          Exact token counts
        </Text>
      </Pressable>
      {expanded && <TokenDetails theme={theme} totals={totals} />}
    </View>
  );
}

export function UsageSummary({
  theme,
  totals,
  compact,
  showCredits = totals.creditEstimate !== undefined,
}: Themed & { totals: Totals; compact: boolean; showCredits?: boolean }) {
  const stats = [
    ...(showCredits
      ? [
          {
            label:
              totals.creditEstimate?.amount != null &&
              totals.creditEstimate.unpricedTokens > 0
                ? "Estimated credits · partial"
                : "Estimated credits",
            value: formatCredits(totals.creditEstimate?.amount),
            minWidth: 160,
          },
        ]
      : []),
    ...(totals.cost !== null
      ? [
          {
            label: "Estimated cost",
            value: formatCost(totals.cost),
            minWidth: 144,
          },
        ]
      : []),
    {
      label: "Total tokens",
      value: compactTokens(totalTokens(totals)),
      minWidth: compact ? 72 : 120,
    },
    {
      label: "Input",
      value: compactTokens(totals.input),
      minWidth: compact ? 72 : 120,
    },
    {
      label: "Output",
      value: compactTokens(totals.output),
      minWidth: compact ? 72 : 120,
    },
  ];

  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderRadius: 10,
        padding: compact ? 16 : 24,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: compact ? 16 : 32,
        }}
      >
        {stats.map(({ label, value, minWidth }, index) => (
          <View key={label} style={{ flex: 1, minWidth, gap: 6 }}>
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 12,
                lineHeight: 18,
              }}
            >
              {label}
            </Text>
            <Text
              selectable
              style={{
                color: theme.colors.foreground,
                fontSize: compact ? 22 : 30,
                lineHeight: compact ? 30 : 38,
                fontWeight: index === 0 ? "600" : "400",
                fontVariant: ["tabular-nums"],
              }}
            >
              {value}
            </Text>
          </View>
        ))}
      </View>
      {totals.creditEstimate && totals.creditEstimate.unpricedTokens > 0 && (
        <Text
          style={{
            marginTop: 12,
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 18,
          }}
        >
          {new Intl.NumberFormat(undefined, {
            maximumFractionDigits: 1,
          }).format(
            Math.min(
              99.9,
              (100 * totals.creditEstimate.pricedTokens) /
                (totals.creditEstimate.pricedTokens +
                  totals.creditEstimate.unpricedTokens),
            ),
          )}
          % of tokens priced. Other models have no published rate.
        </Text>
      )}
      <View style={{ marginTop: 12 }}>
        <TokenBreakdown theme={theme} totals={totals} />
      </View>
    </View>
  );
}
