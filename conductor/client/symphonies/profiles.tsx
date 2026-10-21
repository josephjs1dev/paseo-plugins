import { useState, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type {
  ImportProfilesResult,
  ProviderCatalog,
  SyncPreview,
  SyncProfilesResult,
} from "../../shared/symphonies/profiles-rpc";
import type {
  ProfilesState,
  ProfileDraft,
  SaveProfilesResult,
} from "../../shared/symphonies/profiles";
import type { RoutingMode } from "../../shared/symphonies/routing";
import type { PodiumSession, ViewState } from "../podium/session";
import { StatusNotice } from "./profiles-controls";
import { ProfileEditor } from "./profiles-editor";
import { ProfilesPanel, ProfileRow } from "./profiles-list";

/**
 * The Conductor worker profiles plus the actions their editor takes. Built
 * from the profiles RPCs in production (profiles-query.ts) and from
 * in-memory fixtures in tests/preview, so the UI stays rendering-logic only.
 */
export interface ProfilesData {
  state: ProfilesState | undefined;
  loading: boolean;
  stale: boolean;
  providers: ProviderCatalog | undefined;
  /**
   * Creates or replaces one profile against the revision the caller's draft
   * was based on; a rejected save reports status "stale". The caller owns
   * that revision: pass the store revision the draft was opened with, not the
   * latest cache value, so a background refresh cannot silently overwrite
   * someone else's newer changes.
   */
  save(
    draft: ProfileDraft,
    expectedRevision: string,
  ): Promise<SaveProfilesResult>;
  /** Deletes one profile against the draft's base revision. */
  remove(id: string, expectedRevision: string): Promise<SaveProfilesResult>;
  /** Sets the global routing enforcement mode. */
  setMode(
    mode: RoutingMode,
    expectedRevision: string,
  ): Promise<SaveProfilesResult>;
  /** Runs the one-time import from the Paseo agent profiles. */
  importPaseo(expectedRevision: string): Promise<ImportProfilesResult>;
  /**
   * Plans exporting the Conductor profiles to the daemon's Paseo agent
   * profiles without writing. The result binds the Conductor revision and
   * the Paseo list digest the plan was computed from; the sync confirms
   * against both.
   */
  previewPaseoSync(this: void): Promise<SyncPreview>;
  /**
   * Exports the selected profiles against the revisions the preview was
   * planned from. Either side having changed since is rejected as stale with
   * a fresh preview to redraw from; a saved result means the daemon applied
   * and verified the write.
   */
  syncPaseo(
    profileIds: readonly string[],
    expectedRevision: string,
    expectedPaseoRevision: string,
  ): Promise<SyncProfilesResult>;
  /**
   * Reloads profiles after a stale save or failure and resolves the fresh
   * store state, so a caller can rebase its draft revision on it.
   */
  refresh(this: void): Promise<ProfilesState | undefined>;
}

/** A calm placeholder panel for the editor column. */
function PanelIntro({
  theme,
  title,
  body,
  detail,
  testID,
}: {
  theme: PluginTheme;
  title: string;
  body: string;
  detail: string;
  testID?: string;
}) {
  return (
    <View style={{ padding: 28, gap: 10, maxWidth: 620 }}>
      <Text
        testID={testID}
        style={{
          color: theme.colors.foreground,
          fontSize: 19,
          lineHeight: 26,
          fontWeight: "600",
        }}
      >
        {title}
      </Text>
      <Text
        style={{
          color: theme.colors.foreground,
          fontSize: 14,
          lineHeight: 22,
        }}
      >
        {body}
      </Text>
      <Text
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 13,
          lineHeight: 20,
        }}
      >
        {detail}
      </Text>
    </View>
  );
}

/**
 * The Podium Profiles tab: a list of worker profile cards beside a form
 * editor. The rows column owns the population controls; the right column
 * owns one profile at a time, or a new one. On narrow widths the list
 * stacks above the editor.
 */
export function ProfileBrowser({
  theme,
  data,
  state,
  session,
  compact,
}: {
  theme: PluginTheme;
  data: ProfilesData;
  state: ViewState;
  session: PodiumSession;
  compact: boolean;
}) {
  const profiles = data.state?.profiles ?? [];
  const hasSelection = Boolean(state.profileSelection);
  const [creating, setCreating] = useState(false);
  const [flashId, setFlashId] = useState<string | null>(null);
  /**
   * The card warning's fix action: advancing tick per activation so an
   * already-open editor re-anchours routing when the action fires again.
   * Ordinary row and new-profile openings clear it, so a later normal open
   * never inherits a stale routing hint.
   */
  const [routingFocus, setRoutingFocus] = useState<
    { id: string; tick: number } | undefined
  >(undefined);
  const selected =
    profiles.find((profile) => profile.id === state.profileSelection) ?? null;
  const visible = hasSelection || creating;
  const openProfile = (id: string): void => {
    setCreating(false);
    setFlashId(null);
    setRoutingFocus(undefined);
    session.update({ profileSelection: id });
  };
  const startNew = (): void => {
    setCreating(true);
    setFlashId(null);
    setRoutingFocus(undefined);
    session.update({ profileSelection: null });
  };
  const fixWarning = (id: string): void => {
    setCreating(false);
    setFlashId(null);
    if (state.profileSelection !== id) {
      session.update({ profileSelection: id });
    }
    setRoutingFocus((previous) =>
      previous?.id === id ? { id, tick: previous.tick + 1 } : { id, tick: 1 },
    );
  };
  const mode = data.state?.mode ?? "warn";
  const createdEditor = creating && !selected;
  const rightPanel = ((): ReactNode => {
    if (createdEditor) {
      return (
        <ProfileEditor
          key="profile-new"
          theme={theme}
          data={data}
          mode={mode}
          compact={compact}
          session={session}
          profile={null}
          flashSaved={false}
          onCreated={openProfile}
          onClosed={() => setCreating(false)}
        />
      );
    }
    if (selected) {
      return (
        <ProfileEditor
          key={selected.id}
          theme={theme}
          data={data}
          mode={mode}
          compact={compact}
          session={session}
          profile={selected}
          flashSaved={flashId === selected.id}
          {...(routingFocus && routingFocus.id === selected.id
            ? { routingHint: routingFocus.tick }
            : {})}
          onCreated={(id) => {
            setFlashId(id);
            openProfile(id);
          }}
          {...(creating ? { onClosed: () => setCreating(false) } : {})}
        />
      );
    }
    if (hasSelection) {
      return (
        <PanelIntro
          theme={theme}
          title="This profile is no longer in the store"
          body="It may have been deleted on this server."
          detail="Reload the profiles list to see the current store."
        />
      );
    }
    return (
      <PanelIntro
        theme={theme}
        testID="profiles-intro"
        title="Choose a profile to edit, or create a new one"
        body="Profiles choose the worker, its thinking option and permission mode, and carry the instructions each task agent receives."
        detail={`Routing picks the smallest profile that fits the task's role, using the when-to-use notes and the roles and size each profile declares. Enforce routing is ${mode === "strict" ? "on" : "off"}.`}
      />
    );
  })();
  return (
    <View testID="profiles-browser" style={{ flex: 1, minHeight: 0 }}>
      <View
        style={{
          flex: 1,
          minHeight: 0,
          flexDirection: compact ? "column" : "row",
        }}
      >
        <ScrollView
          testID="profiles-queue"
          style={[
            {
              flexShrink: 0,
              minWidth: 0,
            },
            compact
              ? { maxHeight: "60%", flexGrow: 0 }
              : {
                  width: "39%",
                  flexBasis: "39%",
                  borderRightWidth: 1,
                  borderRightColor: theme.colors.border,
                },
          ]}
          contentContainerStyle={{ padding: 14, gap: 12 }}
        >
          <ProfilesPanel
            theme={theme}
            data={data}
            mode={mode}
            compact={compact}
            empty={profiles.length === 0}
            onNew={startNew}
          />
          {data.state?.state === "invalid" && data.state.error && (
            <StatusNotice
              theme={theme}
              tone="warning"
              testID="profiles-invalid-notice"
            >
              The Conductor profiles store is invalid. Saving a profile from the
              editor replaces it with a valid store. {data.state.error}
            </StatusNotice>
          )}
          {data.loading && (
            <Text
              accessibilityRole="text"
              testID="profiles-loading"
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 13,
                lineHeight: 20,
              }}
            >
              Loading profiles…
            </Text>
          )}
          {!data.loading &&
            !data.stale &&
            data.state?.state !== "invalid" &&
            profiles.length === 0 && (
              <View testID="profiles-empty">
                <Text
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 14,
                    lineHeight: 22,
                    fontWeight: "600",
                  }}
                >
                  Set up your first profile
                </Text>
                <Text
                  style={{
                    color: theme.colors.foregroundMuted,
                    fontSize: 12,
                    lineHeight: 19,
                  }}
                >
                  A profile picks a worker provider, model, mode and thinking
                  option, tells the Conductor when routing may choose it, and
                  carries the instructions its task agents receive. Import your
                  Paseo agent profiles once to start from them, or create one.
                </Text>
              </View>
            )}
          {profiles.map((profile) => (
            <ProfileRow
              key={profile.id}
              theme={theme}
              profile={profile}
              providers={data.providers}
              selected={profile.id === state.profileSelection}
              onSelect={() => openProfile(profile.id)}
              onFixWarning={() => fixWarning(profile.id)}
            />
          ))}
        </ScrollView>
        {(!compact || visible) && (
          <View style={{ flex: 1, minWidth: 0 }}>{rightPanel}</View>
        )}
      </View>
    </View>
  );
}
