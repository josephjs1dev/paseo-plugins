import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  useAgent,
  usePaseo,
  useRpc,
  useSettings,
  type PluginHostProps,
} from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import {
  DEFAULT_SETTINGS,
  contextReminderSettings,
  snoozeReminder,
  type ReminderNotice,
} from "../../shared/context-reminder/contracts";
import { formatGauge } from "../../shared/context-reminder/gauge";
import { PixelSprite } from "./pixel-sprite";
import { useReading } from "./readings";

const ADVICE = {
  warn: "This session is getting long. Plan a stopping point.",
  ask: "Context is large. Compact before the next task.",
} as const;

interface ReminderCardProps {
  theme: PluginTheme;
  layout: PluginHostProps["layout"];
  agentId: string;
  notice: ReminderNotice;
}

export function ReminderCard({
  theme,
  layout,
  agentId,
  notice,
}: ReminderCardProps) {
  const { colors } = theme;
  const paseo = usePaseo();
  const snooze = useRpc(snoozeReminder);
  const toast = useToast();
  const settings = useSettings(contextReminderSettings);
  const character =
    settings.status === "ready"
      ? settings.values.character
      : DEFAULT_SETTINGS.character;
  const liveStatus = useAgent(agentId, (agent) => agent.status);
  const reading = useReading(agentId);
  const isIdle = (liveStatus ?? reading?.status) === "idle";
  const [pending, setPending] = useState<"compact" | "snooze" | null>(null);
  const [isSnoozed, setIsSnoozed] = useState(false);

  async function compactNow() {
    setPending("compact");

    try {
      await paseo.agents.ref(agentId).send("/compact");
      toast.show("Sent /compact.", { variant: "success" });
    } catch {
      toast.error("Could not send /compact.");
    } finally {
      setPending(null);
    }
  }

  async function snoozeReminders() {
    setPending("snooze");

    try {
      await snooze({ agentId, minutes: notice.snoozeMinutes });
      setIsSnoozed(true);
      toast.show(`Snoozed for ${notice.snoozeMinutes} min.`, {
        variant: "success",
      });
    } catch {
      toast.error("Could not snooze reminders.");
    } finally {
      setPending(null);
    }
  }

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: layout.compact ? 10 : 14,
        padding: layout.compact ? 12 : 14,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
      }}
    >
      <PixelSprite
        character={character}
        tier={notice.tier}
        pixelSize={layout.compact ? 3 : 4}
      />
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <Text
          style={{
            color:
              notice.tier === "ask"
                ? colors.statusDanger
                : colors.statusWarning,
            fontSize: 14,
            fontWeight: "600",
          }}
        >
          Context Reminder
        </Text>
        <Text
          style={{
            color: colors.foreground,
            fontSize: 13,
            fontVariant: ["tabular-nums"],
          }}
        >
          {formatGauge(notice.usedTokens, notice.maxTokens)}
        </Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>
          {ADVICE[notice.tier]}
        </Text>
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 8,
            marginTop: 6,
          }}
        >
          <CardButton
            theme={theme}
            label={isIdle ? "Compact now" : "Compact when idle"}
            isPrimary
            disabled={!isIdle || pending !== null}
            onPress={() => void compactNow()}
          />
          <CardButton
            theme={theme}
            label={isSnoozed ? "Snoozed" : `Snooze ${notice.snoozeMinutes} min`}
            disabled={isSnoozed || pending !== null}
            onPress={() => void snoozeReminders()}
          />
        </View>
      </View>
    </View>
  );
}

function buttonOpacity(disabled: boolean, pressed: boolean): number {
  if (disabled) {
    return 0.5;
  }

  return pressed ? 0.7 : 1;
}

interface CardButtonProps {
  theme: PluginTheme;
  label: string;
  isPrimary?: boolean;
  disabled: boolean;
  onPress(): void;
}

function CardButton({
  theme,
  label,
  isPrimary = false,
  disabled,
  onPress,
}: CardButtonProps) {
  const { colors } = theme;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: isPrimary ? colors.accent : colors.border,
        backgroundColor: isPrimary ? colors.accent : colors.surface2,
        opacity: buttonOpacity(disabled, pressed),
      })}
    >
      <Text
        style={{
          color: isPrimary ? colors.accentForeground : colors.foreground,
          fontSize: 13,
          fontWeight: "500",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
