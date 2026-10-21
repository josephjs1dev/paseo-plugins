import { useRef, useState } from "react";
import { Pressable, Text, View, type PressableProps } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  isClassifiedRouting,
  type RoutingMode,
} from "../../shared/symphonies/routing";
import type { ConductorProfile } from "../../shared/symphonies/profiles";
import type { ProviderCatalog } from "../../shared/symphonies/profiles-rpc";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Button, rowStyle } from "../ui/controls";
import { HarnessMark } from "../ui/harness-mark";
import { cardSurface } from "../ui/card";
import { RoleChip } from "../ui/role-chip";
import { StatusNotice, TintedView } from "./profiles-controls";
import { ProfilesSyncDialog } from "./profiles-sync";
import { identityLabel, profileIdentity } from "./worker-identity";
import type { ProfilesData } from "./profiles";

/**
 * React Native Web 0.21 forwards onKeyDown to the DOM at runtime, but the
 * project's @types/react-native prop unions predate it. Keep the escape
 * hatch scoped to this type, like profiles-picker.tsx.
 */
type KeyDownProps = {
  onKeyDown?: (event: {
    key: string;
    repeat?: boolean | undefined;
    preventDefault(this: void): void;
  }) => void;
};

/**
 * The list header: profile creation, the one-time import from Paseo agent
 * profiles, and the global routing enforcement switch. Import results and
 * store problems surface here, where the action was taken.
 */
/**
 * What the routing toggle promises per state. Off (warn) trusts the Conductor
 * and records deviations; on (strict) requires it to justify each one.
 */
const MODE_DESCRIPTION: Record<RoutingMode, string> = {
  warn: "Picks outside routing are allowed and noted on the task.",
  strict:
    "Picks outside routing need a justification with evidence, or they are rejected.",
};

/** The collapsed comparison behind "Learn what's checked", per mode. */
const CHECKED_LINES: Record<RoutingMode, string[]> = {
  warn: [
    "The smallest eligible profile is always accepted.",
    "A larger profile, an unclassified profile, or the Conductor's own model " +
      "is accepted and noted on the task.",
    "A task with no eligible profile and no explicit choice is always " +
      "rejected.",
  ],
  strict: [
    "The smallest eligible profile is always accepted.",
    "A larger profile, an unclassified profile, or the Conductor's own model " +
      "needs an override with evidence.",
    "A task with no eligible profile and no explicit choice is always " +
      "rejected.",
  ],
};

/** The checked line that applies to both modes, last in the disclosure. */
const RECHECK_LINE =
  "Turning this on also rechecks the next retry of tasks already running.";

/** Track width plus the gap to the label, so text below aligns with it. */
const SWITCH_INDENT = 32 + 10;

/**
 * The drawn switch track. Off keeps a visible outline and thumb in the
 * foreground color, because a surface-on-surface track disappears; on fills
 * with the accent. Display only: the parent pressable is the control.
 */
function SwitchTrack({ theme, on }: { theme: PluginTheme; on: boolean }) {
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      aria-hidden
      style={{
        width: 32,
        height: 18,
        borderRadius: 9,
        borderWidth: 1.5,
        borderColor: on ? theme.colors.accent : theme.colors.foregroundMuted,
        backgroundColor: on ? theme.colors.accent : "transparent",
        justifyContent: "center",
        paddingHorizontal: 2,
      }}
    >
      <View
        style={{
          width: 11,
          height: 11,
          borderRadius: 6,
          alignSelf: on ? "flex-end" : "flex-start",
          backgroundColor: on
            ? theme.colors.accentForeground
            : theme.colors.foregroundMuted,
        }}
      />
    </View>
  );
}

export function ProfilesPanel({
  theme,
  data,
  mode,
  compact,
  empty,
  onNew,
}: {
  theme: PluginTheme;
  data: ProfilesData;
  mode: RoutingMode;
  compact: boolean;
  /** True while the store is empty, so import can act as the primary action. */
  empty: boolean;
  onNew(this: void): void;
}) {
  const syncTriggerRef = useRef<View>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    text: string;
    tone: "success" | "warning";
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showChecked, setShowChecked] = useState(false);
  const strict = mode === "strict";
  const run = async (action: "mode" | "import"): Promise<void> => {
    const expectedRevision = data.state?.revision;
    if (!expectedRevision) {
      setError("Profiles are still loading. Try again.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (action === "mode") {
        const result = await data.setMode(
          mode === "warn" ? "strict" : "warn",
          expectedRevision,
        );
        if (result.status === "stale") {
          setNotice({
            text: `Mode not applied. ${result.message}`,
            tone: "warning",
          });
        }
        // A successful change needs no banner: the switch state and its
        // description already say what changed, and screen readers announce
        // the new checked state.
        return;
      }
      const result = await data.importPaseo(expectedRevision);
      if (result.status === "stale") {
        setNotice({
          text: `Import not applied. ${result.message}`,
          tone: "warning",
        });
        return;
      }
      const skipped = result.skipped
        .map((skip) => `${skip.name} (${skip.reason})`)
        .join("; ");
      setNotice({
        text:
          `Imported ${result.imported} profile${result.imported === 1 ? "" : "s"}` +
          (skipped ? `. Skipped: ${skipped}.` : "."),
        tone: "success",
      });
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : "The action could not be completed. Reload and try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <View testID="profiles-panel" style={{ gap: 10 }}>
      <View style={rowStyle}>
        <Button
          theme={theme}
          testID="profile-new"
          dense={!compact}
          primary={!empty}
          label="New profile"
          icon="PenLine"
          disabled={busy}
          onPress={onNew}
        />
        <Button
          theme={theme}
          testID="profile-import"
          dense={!compact}
          primary={empty}
          label="Import from Paseo profiles"
          icon="Download"
          disabled={busy}
          onPress={() => {
            run("import").catch(() => undefined);
          }}
        />
        <Button
          ref={syncTriggerRef}
          theme={theme}
          testID="profile-sync"
          dense={!compact}
          label="Sync to Paseo"
          icon="Upload"
          disabled={busy || empty}
          onPress={() => {
            setNotice(null);
            setError(null);
            setSyncOpen(true);
          }}
        />
      </View>
      {syncOpen && (
        <ProfilesSyncDialog
          theme={theme}
          data={data}
          onSaved={(text) => {
            setNotice({ text, tone: "success" });
            setSyncOpen(false);
            syncTriggerRef.current?.focus();
          }}
          onClose={() => {
            setSyncOpen(false);
            syncTriggerRef.current?.focus();
          }}
        />
      )}
      {/* A settings row, not a card: no frame or fill, so it never reads as
          one more profile in the list below. A hairline separates the
          list-wide setting from the cards it governs. */}
      <View
        testID="profiles-mode"
        style={{
          alignSelf: "stretch",
          gap: 4,
          paddingBottom: 12,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        }}
      >
        {/* One control for the whole row: the pressable carries the switch
            role and state, and the track beside the label is drawn. Its key
            handler covers Space, which RNW's press responder activates for
            button-like roles only, exactly once per press. */}
        <Pressable
          testID="profiles-mode-toggle"
          accessibilityRole="switch"
          accessibilityLabel="Enforce routing"
          accessibilityState={{ checked: strict, disabled: busy }}
          aria-checked={strict}
          disabled={busy}
          onPress={() => {
            run("mode").catch(() => undefined);
          }}
          {...({
            onKeyDown: (event) => {
              if (event.key === " " && !event.repeat && !busy) {
                event.preventDefault();
                run("mode").catch(() => undefined);
              }
            },
          } satisfies KeyDownProps as unknown as PressableProps)}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            alignSelf: "flex-start",
            gap: 10,
            paddingVertical: 4,
            opacity: pressed || busy ? 0.85 : 1,
          })}
        >
          <SwitchTrack theme={theme} on={strict} />
          <Text
            style={{
              color: theme.colors.foreground,
              fontSize: 13,
              lineHeight: 18,
              fontWeight: "600",
            }}
          >
            Enforce routing
          </Text>
        </Pressable>
        {/* Indented under the label so the explanation reads as the
            switch's own text; capped to a readable measure on wide panes. */}
        <View style={{ paddingLeft: SWITCH_INDENT, maxWidth: 680, gap: 2 }}>
          <Text
            testID="profiles-mode-note"
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 12,
              lineHeight: 17,
            }}
          >
            {MODE_DESCRIPTION[mode]}
          </Text>
          <Pressable
            testID="profiles-mode-disclosure"
            accessibilityRole="button"
            accessibilityLabel="Learn what's checked"
            accessibilityState={{ expanded: showChecked }}
            aria-expanded={showChecked}
            onPress={() => {
              setShowChecked((value) => !value);
            }}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 2,
              paddingVertical: 4,
              alignSelf: "flex-start",
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <Text
              style={{
                color: theme.colors.foreground,
                fontSize: 12,
                lineHeight: 16,
                fontWeight: "500",
              }}
            >
              Learn what's checked
            </Text>
            <Icon
              name={showChecked ? "ChevronUp" : "ChevronDown"}
              size={12}
              color={theme.colors.foreground}
            />
          </Pressable>
          {showChecked && (
            <View testID="profiles-mode-checked" style={{ gap: 4 }}>
              {[...CHECKED_LINES[mode], RECHECK_LINE].map((line) => (
                <Text
                  key={line}
                  style={{
                    color: theme.colors.foregroundMuted,
                    fontSize: 12,
                    lineHeight: 17,
                  }}
                >
                  {`\u2022 ${line}`}
                </Text>
              ))}
            </View>
          )}
        </View>
      </View>
      {notice && (
        <StatusNotice
          theme={theme}
          tone={notice.tone}
          testID="profiles-panel-notice"
          onDismiss={() => setNotice(null)}
        >
          {notice.text}
        </StatusNotice>
      )}
      {error && (
        <Text
          accessibilityRole="alert"
          testID="profiles-panel-error"
          style={{
            color: theme.colors.statusDanger,
            fontSize: 12,
            lineHeight: 17,
          }}
        >
          {error}
        </Text>
      )}
      {data.stale && (
        <StatusNotice theme={theme} tone="warning">
          Could not load the Conductor profiles. Refresh to check them again.
        </StatusNotice>
      )}
    </View>
  );
}

/**
 * The provider catalog marks the worker line incomplete: an unknown provider
 * id, a provider that is not ready, or a model the provider does not list.
 * Nothing is marked while the catalog has not loaded, so the checklist stays
 * quiet instead of warning about data that is merely missing client-side.
 */
export function profileIncomplete(
  profile: ConductorProfile,
  catalog: ProviderCatalog | undefined,
): boolean {
  if (!catalog) {
    return false;
  }
  const entry = catalog.providers.find(
    (provider) => provider.id === profile.provider,
  );
  if (!entry || !entry.available || entry.models.length === 0) {
    return true;
  }
  if (
    profile.model &&
    !entry.models.some((model) => model.id === profile.model)
  ) {
    return true;
  }
  return false;
}

/**
 * Why routing cannot pick this profile, for the card's own warning row:
 * classification needs at least one role and a size, and it needs a worker
 * the provider catalog reports as available. `undefined` means there is
 * nothing to warn about.
 */
export function profileCardWarning(
  profile: ConductorProfile,
  catalog: ProviderCatalog | undefined,
): string | undefined {
  if (isClassifiedRouting(profile.routing)) {
    return profileIncomplete(profile, catalog)
      ? "The worker is not available, so routing skips this profile."
      : undefined;
  }
  const roles = profile.routing?.roles ?? [];
  if (roles.length > 0) {
    return "Needs a size before routing can pick it.";
  }
  if (profile.routing?.size !== undefined) {
    return "Needs at least one role before routing can pick it.";
  }
  return "Needs roles and size before routing can pick it.";
}

const SIZE_BADGE_LABEL: Record<string, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
};

/**
 * One profile card: a noninteractive container with two sibling buttons. Its
 * name, when-to-use notes, worker row (harness mark plus model and thinking),
 * role chips, size badge and — only when present — an instructions indicator
 * are display content; the Edit button opens the editor and the Fix button on
 * the yellow warning row opens it at Routing. Selection fills the card with a
 * subtle accent tint beneath the buttons, and routing never picks the profile
 * warns in place.
 */
export function ProfileRow({
  theme,
  profile,
  providers,
  selected,
  onSelect,
  onFixWarning,
}: {
  theme: PluginTheme;
  profile: ConductorProfile;
  providers: ProviderCatalog | undefined;
  selected: boolean;
  onSelect(this: void): void;
  /** Selects this profile and opens its editor at Routing. */
  onFixWarning?(this: void): void;
}) {
  const [editFocused, setEditFocused] = useState(false);
  const [warningFocused, setWarningFocused] = useState(false);
  const emphasize = selected || editFocused || warningFocused;
  const warning = profileCardWarning(profile, providers);
  const identity = profileIdentity(profile, providers);
  const roles = profile.routing?.roles ?? [];
  const size = profile.routing?.size;
  return (
    /* A noninteractive container: the Edit and Fix actions stay as two
       sibling buttons so no button nests inside another. The card lifts off
       the surface0 pane with the surface1 fill, the border and — in light
       only, so dark keeps the border alone — a soft shadow. */
    <View
      testID={`profile-row-${profile.name}`}
      style={{
        ...cardSurface(theme),
        borderColor: emphasize ? theme.colors.accent : theme.colors.border,
      }}
    >
      {/* The tint layer fills the whole card so selection reads as a wash. */}
      <TintedView
        color={theme.colors.accent}
        opacity={selected ? 0.12 : 0}
        style={{ borderRadius: 12 }}
        testID="profile-row-tint"
      >
        <View style={{ padding: 12, gap: 6 }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Text
              numberOfLines={1}
              style={{
                color: theme.colors.foreground,
                fontSize: 14,
                fontWeight: "600",
                lineHeight: 20,
                flexShrink: 1,
              }}
            >
              {profile.name}
            </Text>
            <Pressable
              testID={`profile-edit-${profile.name}`}
              accessibilityRole="button"
              accessibilityLabel={`Edit profile: ${profile.name}`}
              accessibilityState={{ selected }}
              onFocus={() => setEditFocused(true)}
              onBlur={() => setEditFocused(false)}
              onPress={onSelect}
              style={({ pressed }) => ({
                minHeight: 30,
                paddingHorizontal: 10,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: editFocused
                  ? theme.colors.accent
                  : theme.colors.border,
                alignItems: "center",
                justifyContent: "center",
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Text
                style={{
                  color: theme.colors.foreground,
                  fontSize: 12,
                  lineHeight: 15,
                  fontWeight: "500",
                }}
              >
                Edit
              </Text>
            </Pressable>
          </View>
          {profile.notes.length > 0 && (
            <Text
              testID="profile-row-notes"
              numberOfLines={2}
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 12,
                lineHeight: 17,
              }}
            >
              {profile.notes}
            </Text>
          )}
          <View
            testID="profile-row-worker"
            style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
          >
            <View style={{ flexShrink: 0 }}>
              <HarnessMark
                provider={identity.provider ?? profile.provider}
                {...(identity.providerLabel
                  ? { label: identity.providerLabel }
                  : {})}
                size={14}
                color={theme.colors.foreground}
                tone="brand"
                surface={theme.colors.surface2}
              />
            </View>
            {/* The provider lives in the accessible label; sighted users read
                it from the mark, and raw ids stand in while the catalog has
                no entry for this provider or model. */}
            <Text
              numberOfLines={1}
              accessibilityLabel={identityLabel(identity)}
              style={{
                color: theme.colors.foreground,
                fontSize: 12,
                lineHeight: 17,
                flexShrink: 1,
              }}
            >
              {[identity.modelLabel, identity.thinkingLabel]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          </View>
          {(roles.length > 0 || size !== undefined) && (
            <View style={[rowStyle, { gap: 6 }]}>
              {roles.map((role) => (
                <RoleChip
                  key={role}
                  theme={theme}
                  role={role}
                  testID={`profile-row-chip-${role}`}
                />
              ))}
              {size !== undefined && (
                <View
                  testID="profile-row-size"
                  style={{
                    minHeight: 22,
                    paddingHorizontal: 9,
                    paddingVertical: 2,
                    borderRadius: 999,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: theme.colors.surface2,
                  }}
                >
                  <Text
                    testID={`profile-row-size-${size}`}
                    style={{
                      color: theme.colors.foreground,
                      fontSize: 11,
                      lineHeight: 15,
                      fontWeight: "600",
                    }}
                  >
                    {SIZE_BADGE_LABEL[size] ?? size}
                  </Text>
                </View>
              )}
            </View>
          )}
          {profile.instructions.length > 0 && (
            <View
              testID="profile-row-instructions"
              style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
            >
              <Icon
                name="FileText"
                size={12}
                color={theme.colors.foregroundMuted}
              />
              <Text
                style={{
                  color: theme.colors.foregroundMuted,
                  fontSize: 11,
                  lineHeight: 15,
                }}
              >
                Has instructions
              </Text>
            </View>
          )}
          {warning && onFixWarning && (
            <Pressable
              testID={`profile-fix-${profile.name}`}
              accessibilityRole="button"
              accessibilityLabel={`Fix ${profile.name} routing: open routing to fix, ${warning}`}
              onPress={onFixWarning}
              onFocus={() => setWarningFocused(true)}
              onBlur={() => setWarningFocused(false)}
              style={{ marginTop: 2 }}
            >
              <View
                testID="profile-row-unclassified"
                style={{
                  borderWidth: 1,
                  borderColor: warningFocused
                    ? theme.colors.accent
                    : "transparent",
                }}
              >
                {/*
                 * The warning surface carries its own opaque base so the
                 * selection tint and any other layer beneath it cannot
                 * change the wash's composited contrast.
                 */}
                <TintedView
                  color={theme.colors.statusWarning}
                  opacity={0.1}
                  style={{
                    borderRadius: 8,
                    backgroundColor: theme.colors.surface1,
                  }}
                  testID="profile-warning-tint"
                >
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                      paddingHorizontal: 10,
                      paddingVertical: 7,
                    }}
                  >
                    <Icon
                      name="TriangleAlert"
                      size={13}
                      color={theme.colors.statusWarning}
                    />
                    <Text
                      style={{
                        color: theme.colors.statusWarning,
                        fontSize: 12,
                        lineHeight: 16,
                        fontWeight: "500",
                        flexShrink: 1,
                      }}
                    >
                      {warning}
                    </Text>
                    <View
                      aria-hidden
                      accessible={false}
                      style={{
                        marginLeft: "auto",
                        flexDirection: "row",
                        gap: 2,
                      }}
                    >
                      <Text
                        style={{
                          color: theme.colors.statusWarning,
                          fontSize: 12,
                          lineHeight: 16,
                          fontWeight: "600",
                        }}
                      >
                        Fix
                      </Text>
                      <Icon
                        name="ArrowUpRight"
                        size={13}
                        color={theme.colors.statusWarning}
                      />
                    </View>
                  </View>
                </TintedView>
              </View>
            </Pressable>
          )}
        </View>
      </TintedView>
    </View>
  );
}
