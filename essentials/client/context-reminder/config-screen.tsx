import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import {
  useSettings,
  type PluginScreenProps,
  type PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  SidebarRow,
} from "@getpaseo/plugin/client/ui";
import {
  ASK_PERCENT_OPTIONS,
  NOTIFY_EVERY_OPTIONS,
  SNOOZE_MINUTE_OPTIONS,
  WARN_PERCENT_OPTIONS,
  contextReminderSettings,
  type ContextReminderSettings,
} from "../../shared/context-reminder/contracts";
import { formatTokens } from "../../shared/context-reminder/gauge";
import type { Character } from "../../shared/context-reminder/sprite";
import { MoodPreview } from "./mood-preview";
import { PixelSprite } from "./pixel-sprite";
import { refreshReminderPills } from "./pills";
import { ThresholdBar } from "./threshold-bar";

export const CONFIG_SCREEN_ID = "context-reminder";
export const CONFIG_TITLE = "Context Reminder";

const SMALL_WINDOW_TOKENS = 258_000;
const CHARACTERS: readonly { value: Character; label: string }[] = [
  { value: "girl", label: "Girl" },
  { value: "boy", label: "Boy" },
];

/** Select options, plus the saved value when it is not a preset. */
function selectOptions(
  presets: readonly number[],
  current: number,
  label: (value: number) => string,
) {
  const values = presets.includes(current)
    ? presets
    : [...presets, current].sort((a, b) => a - b);

  return values.map((value) => ({ label: label(value), value: String(value) }));
}

function percentHint(percent: number): string {
  const large = formatTokens((1_000_000 * percent) / 100);
  const small = formatTokens((SMALL_WINDOW_TOKENS * percent) / 100);

  return `${large} on a 1M window · ${small} on a 258k window`;
}

function turnsLabel(turns: number): string {
  return turns === 1 ? "Every turn" : `${turns} turns`;
}

function minutesLabel(minutes: number): string {
  return minutes < 60 ? `${minutes} min` : `${minutes / 60} h`;
}

function Column({
  theme,
  compact,
  children,
}: {
  theme: PluginTheme;
  compact: boolean;
  children: ReactNode;
}) {
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{
        alignItems: "center",
        padding: compact ? 16 : 24,
      }}
    >
      <View style={{ width: "100%", maxWidth: 720, gap: 24 }}>{children}</View>
    </ScrollView>
  );
}

function Locked({
  isLocked,
  children,
}: {
  isLocked: boolean;
  children: ReactNode;
}) {
  return (
    <View
      pointerEvents={isLocked ? "none" : "auto"}
      accessibilityState={{ disabled: isLocked }}
      style={{ opacity: isLocked ? 0.5 : 1 }}
    >
      {children}
    </View>
  );
}

function Hero({
  theme,
  character,
  saveError,
}: {
  theme: PluginTheme;
  character: Character;
  saveError: string | null;
}) {
  const { colors } = theme;

  return (
    <View style={{ flexDirection: "row", gap: 16, alignItems: "center" }}>
      <PixelSprite character={character} tier={null} pixelSize={4} />
      <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
        <Text
          style={{ color: colors.foreground, fontSize: 20, fontWeight: "600" }}
        >
          {CONFIG_TITLE}
        </Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 14 }}>
          Watches each agent's context window and reminds you to compact before
          it fills. These settings apply to every agent, repository, and
          provider on this host.
        </Text>
        {saveError ? (
          <Text style={{ color: colors.statusDanger, fontSize: 13 }}>
            Could not save: {saveError}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function CharacterPicker({
  theme,
  value,
  disabled,
  onChange,
}: {
  theme: PluginTheme;
  value: Character;
  disabled: boolean;
  onChange(character: Character): void;
}) {
  const { colors } = theme;

  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel="Assistant"
      style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}
    >
      {CHARACTERS.map((option) => {
        const isSelected = option.value === value;

        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ selected: isSelected, disabled }}
            disabled={disabled}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => ({
              width: 96,
              alignItems: "center",
              gap: 8,
              paddingTop: 14,
              paddingBottom: 10,
              borderRadius: 12,
              // A fixed 2 px border keeps the tile size steady on selection.
              borderWidth: 2,
              borderColor: isSelected ? colors.accent : "transparent",
              backgroundColor: colors.surface2,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <PixelSprite character={option.value} tier={null} pixelSize={2} />
            <Text
              style={{
                color: isSelected ? colors.foreground : colors.foregroundMuted,
                fontSize: 13,
                fontWeight: isSelected ? "600" : "400",
              }}
            >
              {option.label}
            </Text>
            {isSelected ? (
              <View
                style={{
                  position: "absolute",
                  top: 6,
                  right: 6,
                  width: 18,
                  height: 18,
                  borderRadius: 9,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: colors.accent,
                }}
              >
                <Icon name="Check" size={12} color={colors.accentForeground} />
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function ConfigScreen({ theme, layout }: PluginScreenProps) {
  const settings = useSettings(contextReminderSettings);
  const { colors } = theme;

  if (settings.status === "loading") {
    return (
      <Column theme={theme} compact={layout.compact}>
        <View style={{ alignItems: "center", gap: 12, paddingVertical: 48 }}>
          <ActivityIndicator color={colors.foregroundMuted} />
          <Text style={{ color: colors.foregroundMuted }}>
            Loading Context Reminder settings…
          </Text>
        </View>
      </Column>
    );
  }

  if (settings.status !== "ready") {
    return (
      <Column theme={theme} compact={layout.compact}>
        <SettingsSection title={CONFIG_TITLE}>
          <SettingsCard>
            <SettingsAction
              label="Settings unavailable"
              hint={settings.error}
              error={settings.saveError}
              actionLabel="Reset"
              disabled={settings.saving}
              onPress={() => {
                void settings.reset().then((isSaved) => {
                  if (isSaved) {
                    refreshReminderPills();
                  }
                });
              }}
            />
          </SettingsCard>
        </SettingsSection>
      </Column>
    );
  }

  const { values, revision } = settings;
  const isLocked = !values.enabled || settings.saving;

  function save(patch: Partial<ContextReminderSettings>) {
    void settings.save({ ...values, ...patch }, revision).then((isSaved) => {
      if (isSaved) {
        refreshReminderPills();
      }
    });
  }

  return (
    <Column theme={theme} compact={layout.compact}>
      <Hero
        theme={theme}
        character={values.character}
        saveError={settings.saveError}
      />
      <SettingsSection title="General">
        <SettingsCard>
          <SettingsSwitch
            label="Show Context Reminder"
            hint="Shows the composer pill and timeline cards."
            value={values.enabled}
            disabled={settings.saving}
            onValueChange={(enabled) => save({ enabled })}
          />
        </SettingsCard>
      </SettingsSection>
      <Locked isLocked={isLocked}>
        <SettingsSection title="Thresholds">
          <SettingsCard>
            <SettingsRow label="Zones">
              <ThresholdBar theme={theme} thresholds={values} />
            </SettingsRow>
            <SettingsSelect
              label="Warn at"
              hint={percentHint(values.warnPercent)}
              value={String(values.warnPercent)}
              options={selectOptions(
                WARN_PERCENT_OPTIONS,
                values.warnPercent,
                (percent) => `${percent}%`,
              )}
              disabled={isLocked}
              onValueChange={(value) => save({ warnPercent: Number(value) })}
            />
            <SettingsSelect
              label="Ask to compact at"
              hint={percentHint(values.askPercent)}
              error={
                values.askPercent <= values.warnPercent
                  ? "Set this above Warn at. Until then, every warning asks to compact."
                  : null
              }
              value={String(values.askPercent)}
              options={selectOptions(
                ASK_PERCENT_OPTIONS,
                values.askPercent,
                (percent) => `${percent}%`,
              )}
              disabled={isLocked}
              onValueChange={(value) => save({ askPercent: Number(value) })}
            />
          </SettingsCard>
        </SettingsSection>
      </Locked>
      <Locked isLocked={isLocked}>
        <SettingsSection title="Reminders">
          <SettingsCard>
            <SettingsSelect
              label="Card every"
              hint="Turns between timeline cards while above Warn at."
              value={String(values.notifyEvery)}
              options={selectOptions(
                NOTIFY_EVERY_OPTIONS,
                values.notifyEvery,
                turnsLabel,
              )}
              disabled={isLocked}
              onValueChange={(value) => save({ notifyEvery: Number(value) })}
            />
            <SettingsSelect
              label="Snooze for"
              hint="How long Snooze pauses an agent's cards."
              value={String(values.snoozeMinutes)}
              options={selectOptions(
                SNOOZE_MINUTE_OPTIONS,
                values.snoozeMinutes,
                minutesLabel,
              )}
              disabled={isLocked}
              onValueChange={(value) => save({ snoozeMinutes: Number(value) })}
            />
          </SettingsCard>
        </SettingsSection>
      </Locked>
      <SettingsSection title="Look">
        <SettingsCard>
          {/* One card child, so the card draws no divider above the picker. */}
          <View>
            <SettingsRow
              label="Assistant"
              hint="Shown in reminder cards and on this screen."
            />
            <View style={{ paddingHorizontal: 16, paddingBottom: 16, gap: 20 }}>
              <CharacterPicker
                theme={theme}
                value={values.character}
                disabled={settings.saving}
                onChange={(character) => save({ character })}
              />
              <MoodPreview
                theme={theme}
                character={values.character}
                thresholds={values}
              />
            </View>
          </View>
        </SettingsCard>
      </SettingsSection>
    </Column>
  );
}

export function ConfigScreenSurface(props: PluginScreenProps) {
  return <ConfigScreen key={props.host.id} {...props} />;
}

export function ConfigSidebarItem({
  currentScreen,
  openScreen,
}: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="AlarmClock"
      active={currentScreen?.screenId === CONFIG_SCREEN_ID}
      onPress={() => openScreen({ screenId: CONFIG_SCREEN_ID })}
    />
  );
}
