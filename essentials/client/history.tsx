import { useState } from "react";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import type { History, Totals } from "../shared/history";
import {
  compactTokens,
  formatCreditEstimate,
  totalTokens,
} from "../shared/history-display";
import {
  HistoryAction,
  HistorySection,
  HistoryValue,
} from "./history-controls";

import { TokenDetails } from "./history-totals";

type Themed = Pick<PluginHostProps, "theme">;

function ModelRow({
  theme,
  model,
  totals,
  compact,
  sessionCount,
  showCredits,
}: Themed & {
  model: string | null;
  totals: Totals;
  compact: boolean;
  sessionCount?: number;
  showCredits: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const name = model ?? "Unknown model";
  const numberStyle = {
    color: theme.colors.foreground,
    fontSize: 13,
    lineHeight: 20,
    fontVariant: ["tabular-nums"] as "tabular-nums"[],
    textAlign: "right" as const,
    width: 88,
  };

  return (
    <View
      style={{ borderBottomWidth: 1, borderBottomColor: theme.colors.border }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={name + " token details"}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={({ pressed }) => ({
          minHeight: 52,
          paddingVertical: 12,
          paddingHorizontal: 8,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          backgroundColor: pressed ? theme.colors.surface1 : "transparent",
        })}
      >
        <Text
          style={{
            color: theme.colors.foreground,
            fontSize: 13,
            lineHeight: 20,
            flex: 1,
            minWidth: 0,
            fontWeight: "500",
          }}
        >
          {name}
        </Text>
        {!compact && (
          <>
            <Text style={numberStyle}>{compactTokens(totals.input)}</Text>
            <Text style={numberStyle}>{compactTokens(totals.output)}</Text>
          </>
        )}
        <Text style={{ ...numberStyle, fontWeight: "600" }}>
          {compactTokens(totalTokens(totals))}
        </Text>
        {showCredits && (
          <Text style={numberStyle}>
            {formatCreditEstimate(totals.creditEstimate)}
          </Text>
        )}
        <Icon
          name={expanded ? "ChevronDown" : "ChevronRight"}
          size={14}
          color={theme.colors.foregroundMuted}
        />
      </Pressable>
      {expanded && (
        <View
          style={{
            backgroundColor: theme.colors.surface1,
            padding: 16,
            borderRadius: 6,
            marginBottom: 12,
          }}
        >
          {sessionCount !== undefined && (
            <HistoryValue
              theme={theme}
              label="Sessions"
              value={String(sessionCount)}
            />
          )}
          <TokenDetails theme={theme} totals={totals} />
        </View>
      )}
    </View>
  );
}

export function ModelUsage({
  theme,
  models,
  compact = true,
  emptyMessage = "No model usage recorded in this period.",
}: Themed & {
  models: { model: string | null; totals: Totals; sessionCount?: number }[];
  compact?: boolean;
  emptyMessage?: string;
}) {
  const labelStyle = {
    color: theme.colors.foregroundMuted,
    fontSize: 11,
    lineHeight: 18,
    width: 88,
    textAlign: "right" as const,
  };
  const showCredits = models.some(
    (entry) => entry.totals.creditEstimate !== undefined,
  );

  return (
    <View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingHorizontal: 8,
          paddingBottom: 8,
          paddingRight: 34,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        }}
      >
        <Text style={{ ...labelStyle, flex: 1, textAlign: "left" }}>Model</Text>
        {!compact && (
          <>
            <Text style={labelStyle}>Input</Text>
            <Text style={labelStyle}>Output</Text>
          </>
        )}
        <Text style={labelStyle}>Tokens</Text>
        {showCredits && <Text style={labelStyle}>Est. credits</Text>}
      </View>
      {models.map((entry) => (
        <ModelRow
          key={JSON.stringify(entry.model)}
          theme={theme}
          {...entry}
          compact={compact}
          showCredits={showCredits}
        />
      ))}
      {models.length === 0 && (
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 13,
            lineHeight: 22,
            paddingVertical: 16,
          }}
        >
          {emptyMessage}
        </Text>
      )}
    </View>
  );
}

export function SessionUsage({
  theme,
  session,
  showDirectory = false,
}: Themed & { session: History["sessions"][number]; showDirectory?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const date = new Date(session.lastAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const models = session.models
    .map(({ model }) => model ?? "Unknown model")
    .join(", ");

  return (
    <View
      style={{ borderBottomWidth: 1, borderBottomColor: theme.colors.border }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={"Session " + session.sessionId}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={({ pressed }) => ({
          minHeight: 64,
          paddingVertical: 12,
          paddingHorizontal: 8,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          backgroundColor: pressed ? theme.colors.surface1 : "transparent",
        })}
      >
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <Text
            style={{
              color: theme.colors.foreground,
              fontSize: 13,
              lineHeight: 20,
              fontWeight: "500",
            }}
          >
            {date} · {session.sessionId.slice(0, 16)}
          </Text>
          <Text
            numberOfLines={1}
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 12,
              lineHeight: 18,
            }}
          >
            {models}
          </Text>
          {showDirectory && (
            <Text
              numberOfLines={1}
              ellipsizeMode="middle"
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 12,
                lineHeight: 18,
              }}
            >
              {session.cwd}
            </Text>
          )}
        </View>
        <Text
          style={{
            color: theme.colors.foreground,
            fontSize: 13,
            lineHeight: 20,
            fontWeight: "600",
            fontVariant: ["tabular-nums"],
            textAlign: "right",
            width: 88,
          }}
        >
          {compactTokens(totalTokens(session.totals))}
        </Text>
        <Icon
          name={expanded ? "ChevronDown" : "ChevronRight"}
          size={14}
          color={theme.colors.foregroundMuted}
        />
      </Pressable>
      {expanded && (
        <View
          style={{
            padding: 16,
            marginBottom: 12,
            gap: 16,
            borderRadius: 6,
            backgroundColor: theme.colors.surface1,
          }}
        >
          <Text
            selectable
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 12,
              lineHeight: 18,
            }}
          >
            {session.sessionId}
          </Text>
          {showDirectory && (
            <Text
              selectable
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 12,
                lineHeight: 18,
              }}
            >
              {session.cwd}
            </Text>
          )}
          {session.models.map(({ model, totals }) => (
            <View key={JSON.stringify(model)} style={{ gap: 8 }}>
              <Text
                style={{
                  color: theme.colors.foreground,
                  fontSize: 13,
                  lineHeight: 20,
                  fontWeight: "600",
                }}
              >
                {model ?? "Unknown model"}
              </Text>
              <TokenDetails theme={theme} totals={totals} />
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

export function HistorySessions({
  theme,
  sessions,
  sessionCount,
  scopeLabel,
  showDirectory,
  sessionOffset,
  onPageChange,
}: Themed & {
  sessions: History["sessions"];
  sessionCount: number;
  scopeLabel: string;
  showDirectory: boolean;
  sessionOffset: number;
  onPageChange(offset: number): void;
}) {
  const start = sessions.length ? sessionOffset + 1 : 0;
  const end = sessions.length ? sessionOffset + sessions.length : 0;

  return (
    <HistorySection
      theme={theme}
      title="Sessions"
      description={
        start + "–" + end + " of " + sessionCount + " · " + scopeLabel
      }
      trailing={
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          Tokens
        </Text>
      }
    >
      <View>
        {sessions.map((session) => (
          <SessionUsage
            key={session.sessionId}
            theme={theme}
            session={session}
            showDirectory={showDirectory}
          />
        ))}
        {sessions.length === 0 && (
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 13,
              lineHeight: 22,
            }}
          >
            {"No sessions recorded. " + scopeLabel + "."}
          </Text>
        )}
      </View>
      {sessionCount > 20 && (
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <HistoryAction
            theme={theme}
            disabled={sessionOffset === 0}
            onPress={() => onPageChange(Math.max(0, sessionOffset - 20))}
          >
            Previous
          </HistoryAction>
          <HistoryAction
            theme={theme}
            disabled={end >= sessionCount}
            onPress={() => onPageChange(sessionOffset + 20)}
          >
            Next
          </HistoryAction>
        </View>
      )}
    </HistorySection>
  );
}
