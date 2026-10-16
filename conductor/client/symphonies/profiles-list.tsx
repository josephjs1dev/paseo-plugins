import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  isClassifiedRouting,
  type RoutingMode,
} from "../../shared/symphonies/routing";
import type { ConductorProfile } from "../../shared/symphonies/profiles";
import type { ProviderCatalog } from "../../shared/symphonies/profiles-rpc";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Button, rowStyle } from "../ui/controls";
import { Segmented, StatusNotice, TintedView } from "./profiles-controls";
import type { ProfilesData } from "./profiles";

/**
 * The list header: profile creation, the one-time import from Paseo agent
 * profiles, and the global routing enforcement switch. Import results and
 * store problems surface here, where the action was taken.
 */
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
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    text: string;
    tone: "success" | "warning";
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
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
        } else {
          setNotice({
            text: `Routing enforcement is now ${result.state.mode}.`,
            tone: "success",
          });
        }
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
      </View>
      <View style={{ gap: 6, alignSelf: "stretch" }}>
        <Segmented<RoutingMode>
          theme={theme}
          compact={compact}
          options={[
            {
              value: "warn",
              label: "Warn",
              accessibilityLabel:
                "Routing mode warn. Off-profile picks are warnings.",
            },
            {
              value: "strict",
              label: "Strict",
              accessibilityLabel:
                "Routing mode strict. Tasks that bypass routing are rejected.",
            },
          ]}
          value={mode}
          onChange={(next) => {
            if (next && next !== mode) {
              run("mode").catch(() => undefined);
            }
          }}
        />
        <Text
          testID="profiles-mode-note"
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 11,
            lineHeight: 16,
          }}
        >
          {mode === "warn"
            ? "Warn: a task picking its own worker is noted."
            : "Strict: a task picking its own worker is rejected."}
        </Text>
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

const ROLE_CHIP_LABEL: Record<string, string> = {
  exploration: "Exploration",
  implementation: "Implementation",
  planning: "Planning",
  review: "Review",
};

/** The worker line: provider · model · thinking labels when the catalog has them. */
function workerLine(
  profile: ConductorProfile,
  catalog: ProviderCatalog | undefined,
): string {
  const entry = catalog?.providers.find(
    (provider) => provider.id === profile.provider,
  );
  const modelEntry = entry?.models.find((model) => model.id === profile.model);
  const thinkingEntry = modelEntry?.thinkingOptions.find(
    (option) => option.id === profile.thinkingOptionId,
  );
  return [
    entry?.label ?? profile.provider,
    modelEntry?.label ?? profile.model,
    thinkingEntry?.label ?? profile.thinkingOptionId,
  ]
    .filter(Boolean)
    .join(" · ");
}

function Chip({ theme, label }: { theme: PluginTheme; label: string }) {
  return (
    <View
      style={{
        minHeight: 22,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        numberOfLines={1}
        style={{ color: theme.colors.foreground, fontSize: 11, lineHeight: 15 }}
      >
        {label}
      </Text>
    </View>
  );
}

/**
 * One profile card: a noninteractive container with two sibling buttons. Its
 * name, when-to-use notes, worker line, role chips, size badge and — only
 * when present — an instructions indicator are display content; the Edit
 * button opens the editor and the Fix button on the yellow warning row opens
 * it at Routing. Selection fills the card with a subtle accent tint beneath
 * the buttons, and routing never picks the profile warns in place.
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
  const roles = profile.routing?.roles ?? [];
  const size = profile.routing?.size;
  return (
    /* A noninteractive container: the Edit and Fix actions stay as two
       sibling buttons so no button nests inside another. */
    <View
      testID={`profile-row-${profile.name}`}
      style={{
        borderRadius: 12,
        borderWidth: 1,
        borderColor: emphasize ? theme.colors.accent : theme.colors.border,
        backgroundColor: theme.colors.surface1,
        overflow: "hidden",
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
          <Text
            numberOfLines={1}
            testID="profile-row-worker"
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 12,
              lineHeight: 17,
            }}
          >
            {workerLine(profile, providers)}
          </Text>
          {(roles.length > 0 || size !== undefined) && (
            <View style={[rowStyle, { gap: 6 }]}>
              {roles.map((role) => (
                <Chip
                  key={role}
                  label={ROLE_CHIP_LABEL[role] ?? role}
                  theme={theme}
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
