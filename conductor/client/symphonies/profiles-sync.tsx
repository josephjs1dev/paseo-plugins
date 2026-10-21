import { useEffect, useState } from "react";
import { Pressable, Text, View, type PressableProps } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import type {
  SyncPreview,
  SyncPreviewEntry,
  SyncProfilesResult,
} from "../../shared/symphonies/profiles-rpc";
import type { ConductorProfile } from "../../shared/symphonies/profiles";
import { Button } from "../ui/controls";
import { HarnessMark } from "../ui/harness-mark";
import { StatusNotice } from "./profiles-controls";
import { identityLabel, profileIdentity } from "./worker-identity";
import type { ProfilesData } from "./profiles";

/**
 * React Native Web 0.21 forwards onKeyDown to the DOM at runtime, but the
 * project's @types/react-native prop unions predate it. Keep the escape
 * hatch scoped to this type, like profiles-list.tsx.
 */
type KeyDownProps = {
  onKeyDown?: (event: {
    key: string;
    repeat?: boolean | undefined;
    preventDefault(this: void): void;
  }) => void;
};

/** The panel footer's line for a saved export: counts plus every skip. */
export function savedNotice(
  result: Extract<SyncProfilesResult, { status: "saved" }>,
): string {
  const skipped = result.skipped
    .map((skip) => `${skip.name} (${skip.reason})`)
    .join("; ");
  let text = `Synced to Paseo: ${result.created} created, ${result.updated} updated`;
  if (result.unchanged > 0) {
    text += `, ${result.unchanged} up to date`;
  }
  text += ".";
  if (skipped !== "") {
    text += ` Skipped: ${skipped}.`;
  }
  return text;
}

/** What the dialog says one row would do in Paseo. */
function actionLabel(entry: SyncPreviewEntry): string {
  switch (entry.action) {
    case "create":
      return "New in Paseo";
    case "update":
      return entry.paseoName !== undefined
        ? `Updates ${entry.paseoName}`
        : "Updates a Paseo profile";
    case "unchanged":
      return "Up to date";
    case "skip":
      return entry.reason ?? "This profile cannot be synced.";
  }
}

/** The status color the planned action reads in, per action. */
function actionColor(
  entry: SyncPreviewEntry,
  theme: PluginTheme,
): string | undefined {
  switch (entry.action) {
    case "create":
      return theme.colors.statusSuccess;
    case "update":
      return theme.colors.foreground;
    case "unchanged":
      return theme.colors.foregroundMuted;
    case "skip":
      return theme.colors.statusWarning;
  }
}

/**
 * One selectable export row: the drawn checkbox (the pressable carries the
 * checkbox role and state, like the routing switch draws its track), then
 * the profile name, its worker line and the planned action. A skipped row
 * renders disabled with its reason in place of an action.
 */
function SyncRow({
  theme,
  entry,
  profile,
  providers,
  checked,
  onToggle,
}: {
  theme: PluginTheme;
  entry: SyncPreviewEntry;
  /** The Conductor profile behind this row; undefined while it is missing. */
  profile: ConductorProfile | undefined;
  providers: ProfilesData["providers"];
  checked: boolean;
  onToggle(this: void): void;
}) {
  const identity = profile ? profileIdentity(profile, providers) : null;
  const color = actionColor(entry, theme);
  const disabledRow = entry.action === "skip";
  const rowOpacity = (pressed: boolean): number => {
    if (disabledRow) {
      return 0.55;
    }
    return pressed ? 0.85 : 1;
  };
  const rowKeyDown = {
    onKeyDown: (event: {
      key: string;
      repeat?: boolean | undefined;
      preventDefault(this: void): void;
    }) => {
      // RNW's own press responder activates Space for button-like roles
      // only, so checkbox rows need this explicit handler.
      if (event.key === " " && !event.repeat) {
        event.preventDefault();
        onToggle();
      }
    },
  } satisfies KeyDownProps;
  return (
    <Pressable
      testID={`profile-sync-row-${entry.name}`}
      accessibilityRole="checkbox"
      accessibilityLabel={`${entry.name}: ${actionLabel(entry)}`}
      accessibilityState={{
        checked,
        disabled: disabledRow,
      }}
      aria-checked={checked}
      disabled={disabledRow}
      onPress={onToggle}
      {...(rowKeyDown as unknown as PressableProps)}
      style={({ pressed }: { pressed: boolean }) => ({
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        paddingVertical: 8,
        opacity: rowOpacity(pressed),
      })}
    >
      <View
        aria-hidden
        accessible={false}
        style={{
          width: 18,
          height: 18,
          marginTop: 1,
          borderRadius: 5,
          borderWidth: 1.5,
          borderColor: checked
            ? theme.colors.accent
            : theme.colors.foregroundMuted,
          backgroundColor: checked ? theme.colors.accent : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {checked && (
          <Icon name="Check" size={13} color={theme.colors.accentForeground} />
        )}
      </View>
      <View style={{ flexShrink: 1, gap: 3 }}>
        <Text
          numberOfLines={1}
          style={{
            color: theme.colors.foreground,
            fontSize: 13,
            lineHeight: 18,
            fontWeight: "600",
          }}
        >
          {entry.name}
        </Text>
        {identity && profile && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
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
        )}
        <Text
          numberOfLines={2}
          style={{
            color: color ?? theme.colors.foreground,
            fontSize: 12,
            lineHeight: 17,
          }}
        >
          {actionLabel(entry)}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * The Sync to Paseo dialog: a Modal listing the Conductor profiles with
 * checkboxes, each row showing what the export would do in Paseo. Nothing is
 * selected until the user picks rows; the confirm button needs at least one.
 * Routing and instructions stay in Conductor — only the worker identity,
 * notes and permission mode cross over. A stale export keeps the dialog open
 * and redraws from the fresh preview the server returned.
 */
export function ProfilesSyncDialog({
  theme,
  data,
  onSaved,
  onClose,
}: {
  theme: PluginTheme;
  data: ProfilesData;
  /** A saved export; the panel closes the dialog and shows this notice. */
  onSaved(this: void, notice: string): void;
  /** Cancels or dismisses; the panel forgets the dialog and restores focus. */
  onClose(this: void): void;
}) {
  const [preview, setPreview] = useState<SyncPreview | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<
    { text: string; tone: "warning" | "danger" } | undefined
  >(undefined);
  const profiles = data.state?.profiles ?? [];
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const selectable = (preview?.entries ?? []).filter(
    (entry) => entry.action !== "skip",
  );
  const selectedIds = selectable
    .filter((entry) => selected.has(entry.profileId))
    .map((entry) => entry.profileId);

  // The plan loads once per mount — the panel remounts the dialog each time
  // it opens, so the preview is always the current state of both stores.
  useEffect(() => {
    let active = true;
    data.previewPaseoSync().then(
      (value) => {
        if (active) {
          setPreview(value);
        }
      },
      (cause: unknown) => {
        if (!active) {
          return;
        }
        setLoadError(
          cause instanceof Error && cause.message !== ""
            ? cause.message
            : "The sync plan could not be loaded. Cancel and try again.",
        );
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const toggle = (id: string): void => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const confirm = async (): Promise<void> => {
    if (!preview || selectedIds.length === 0 || busy) {
      return;
    }
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await data.syncPaseo(
        selectedIds,
        preview.revision,
        preview.paseoRevision,
      );
      if (result.status === "stale") {
        // Keep the dialog open, redraw from the returned preview, and keep
        // only the selection that still exists in it.
        setPreview(result.preview);
        setSelected((previous) => {
          const next = new Set<string>();
          for (const entry of result.preview.entries) {
            if (previous.has(entry.profileId)) {
              next.add(entry.profileId);
            }
          }
          return next;
        });
        setNotice({ text: result.message, tone: "warning" });
        return;
      }
      onSaved(savedNotice(result));
    } catch (cause) {
      setNotice({
        text:
          cause instanceof Error && cause.message !== ""
            ? cause.message
            : "The sync could not be completed. Try again.",
        tone: "danger",
      });
    } finally {
      setBusy(false);
    }
  };

  const confirmLabel = `Sync ${selectedIds.length} profile${
    selectedIds.length === 1 ? "" : "s"
  }`;

  return (
    <Modal
      title="Sync to Paseo"
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <Modal.Content>
        <View testID="profile-sync-dialog" style={{ gap: 10 }}>
          {!preview && !loadError && (
            <Text
              testID="profile-sync-loading"
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 13,
                lineHeight: 20,
              }}
            >
              Checking what would change in Paseo…
            </Text>
          )}
          {loadError && (
            <Text
              accessibilityRole="alert"
              testID="profile-sync-error"
              style={{
                color: theme.colors.statusDanger,
                fontSize: 12,
                lineHeight: 17,
              }}
            >
              {loadError}
            </Text>
          )}
          {notice && (
            <StatusNotice
              theme={theme}
              tone={notice.tone}
              testID="profile-sync-notice"
            >
              {notice.text}
            </StatusNotice>
          )}
          {preview && (
            <>
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
              >
                <Button
                  theme={theme}
                  testID="profile-sync-select-all"
                  dense
                  label="Select all"
                  disabled={busy || selectable.length === 0}
                  onPress={() => {
                    setSelected(
                      new Set(selectable.map((entry) => entry.profileId)),
                    );
                  }}
                />
                <Button
                  theme={theme}
                  testID="profile-sync-clear"
                  dense
                  label="Clear"
                  disabled={busy || selected.size === 0}
                  onPress={() => {
                    setSelected(new Set());
                  }}
                />
              </View>
              <View testID="profile-sync-rows" style={{ gap: 2 }}>
                {preview.entries.map((entry) => (
                  <SyncRow
                    key={entry.profileId}
                    theme={theme}
                    entry={entry}
                    profile={byId.get(entry.profileId)}
                    providers={data.providers}
                    checked={selected.has(entry.profileId)}
                    onToggle={() => toggle(entry.profileId)}
                  />
                ))}
              </View>
              <Text
                style={{
                  color: theme.colors.foregroundMuted,
                  fontSize: 12,
                  lineHeight: 17,
                }}
              >
                Routing and instructions stay in Conductor. Paseo profiles you
                do not select are never changed.
              </Text>
            </>
          )}
          <View
            style={{
              flexDirection: "row",
              justifyContent: "flex-end",
              gap: 8,
            }}
          >
            <Button
              theme={theme}
              testID="profile-sync-cancel"
              label="Cancel"
              disabled={busy}
              onPress={onClose}
            />
            <Button
              theme={theme}
              testID="profile-sync-confirm"
              primary
              label={confirmLabel}
              disabled={
                busy || preview === undefined || selectedIds.length === 0
              }
              onPress={() => {
                confirm().catch(() => undefined);
              }}
            />
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
}
