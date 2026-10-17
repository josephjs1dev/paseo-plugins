import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  STALE_SAVE_MESSAGE,
  type ConductorProfile,
  type ProfileDraft,
} from "../../shared/symphonies/profiles";
import type { RoutingMode, RoutingRole } from "../../shared/symphonies/routing";
import type { PodiumSession } from "../podium/session";
import { Button } from "../ui/controls";
import {
  Segmented,
  StatusNotice,
  TintedView,
  fieldBorderColor,
} from "./profiles-controls";
import {
  PROFILE_ROLES,
  PROFILE_SIZES,
  duplicateProfileForm,
  newProfileForm,
  profileDraftFromForm,
  profileFormFor,
  profileFormKey,
  validateProfileForm,
  type ProfileField,
  type ProfileForm,
  type ProfileFormErrors,
} from "./profiles-draft";
import { ProfilePicker, type PickerOption } from "./profiles-picker";
import type { ProfilesData } from "./profiles";

const ROLE_LABELS: Record<RoutingRole, string> = {
  exploration: "Exploration",
  implementation: "Implementation",
  planning: "Planning",
  review: "Review",
};

const SIZE_LABELS: Record<string, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
};

/**
 * One filled text input: surface-filled with a rounded boundary that lights
 * up with the accent on keyboard focus and with danger on a field error.
 */
function Input({
  theme,
  label,
  error,
  multiline = false,
  minHeight,
  width,
  ...rest
}: {
  theme: PluginTheme;
  label: string;
  error?: string | undefined;
} & React.ComponentProps<typeof TextInput> & {
    minHeight?: number | undefined;
    width?: number | undefined;
  }) {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      accessibilityLabel={label}
      multiline={multiline}
      {...rest}
      onFocus={(event) => {
        setFocused(true);
        rest.onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        rest.onBlur?.(event);
      }}
      style={{
        marginTop: 4,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: fieldBorderColor(theme, focused, error),
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 8,
        fontSize: 13,
        lineHeight: 20,
        ...(multiline
          ? { minHeight: minHeight ?? 72, textAlignVertical: "top" }
          : {}),
        ...(width ? { maxWidth: width } : {}),
      }}
    />
  );
}

/** One labeled editor field with its helper line and, when present, inline error. */
function Field({
  theme,
  field,
  label,
  helper,
  error,
  children,
}: {
  theme: PluginTheme;
  /** Suffix of the `profile-error-${field}` test id. */
  field: ProfileField;
  label: string;
  helper?: string | undefined;
  error?: string | undefined;
  children?: ReactNode;
}) {
  return (
    <View style={{ gap: 3 }}>
      <Text
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          lineHeight: 16,
          fontWeight: "500",
        }}
      >
        {label}
      </Text>
      {children}
      {helper && (
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 11,
            lineHeight: 15,
          }}
        >
          {helper}
        </Text>
      )}
      {error && (
        <Text
          accessibilityRole="alert"
          testID={`profile-error-${field}`}
          style={{
            color: theme.colors.statusDanger,
            fontSize: 12,
            lineHeight: 17,
          }}
        >
          {error}
        </Text>
      )}
    </View>
  );
}

/** A section heading inside the editor form. */
function Section({ theme, title }: { theme: PluginTheme; title: string }) {
  return (
    <Text
      style={{
        color: theme.colors.foreground,
        fontSize: 14,
        lineHeight: 20,
        fontWeight: "600",
        marginTop: 6,
      }}
    >
      {title}
    </Text>
  );
}

/**
 * Redirect helper: refs of the react-native types are the rendered DOM nodes
 * on web, but the prop unions predate the web-only navigation methods.
 */
interface ElementLike {
  scrollIntoView?: (options?: { block?: string }) => void;
  focus?: (this: void) => void;
  querySelector?: (selector: string) => ElementLike | null;
}

function routingElement(ref: { current: View | null }): ElementLike | null {
  const node = ref.current as ElementLike | null;
  return node && typeof node.querySelector === "function" ? node : null;
}

/** A toggle chip for one routing role. */
function RoleChip({
  theme,
  role,
  selected,
  onToggle,
}: {
  theme: PluginTheme;
  role: RoutingRole;
  selected: boolean;
  onToggle(this: void): void;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      testID={`profile-role-${role}`}
      accessibilityRole="button"
      accessibilityLabel={`${ROLE_LABELS[role]} role`}
      accessibilityState={{ selected }}
      aria-pressed={selected}
      onPress={onToggle}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed }) => ({
        minHeight: 34,
        paddingHorizontal: 12,
        borderRadius: 999,
        borderWidth: 1,
        borderColor:
          focused || selected ? theme.colors.accent : theme.colors.border,
        backgroundColor: selected ? theme.colors.accent : "transparent",
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Text
        style={{
          color: selected
            ? theme.colors.accentForeground
            : theme.colors.foreground,
          fontSize: 12,
          lineHeight: 16,
          fontWeight: selected ? "600" : "400",
        }}
      >
        {ROLE_LABELS[role]}
      </Text>
    </Pressable>
  );
}

/**
 * The editor panel for one Conductor worker profile, or for a new one when
 * `profile` is null. Validation runs on save; a server-reported stale save
 * keeps the editor's text and offers a reload instead of throwing the work
 * away. The server re-checks everything and owns the store's ids.
 */
export function ProfileEditor({
  theme,
  data,
  mode,
  compact,
  session,
  profile,
  flashSaved = false,
  routingHint,
  onCreated,
  onClosed,
}: {
  theme: PluginTheme;
  data: ProfilesData;
  /** The global routing mode, shown in the routing helper. */
  mode: RoutingMode;
  compact: boolean;
  session: PodiumSession;
  /** The profile being edited, or null for a created one. */
  profile: ConductorProfile | null;
  /** Marks a freshly created draft so its saved confirmation can show. */
  flashSaved?: boolean | undefined;
  /**
   * Card warning fix actions hand the editor a hint tick: the Routing section
   * scrolls into view and a role or size control takes focus. A hint present
   * at mount (a fresh open from the action) and a hint change on an open
   * editor (the same profile fixed again) both trigger it.
   */
  routingHint?: number | undefined;
  onCreated?(this: void, profileId: string): void;
  /** Offered for a created profile that never gets saved. */
  onClosed?(this: void): void;
}) {
  const allProfiles = data.state?.profiles ?? [];
  const [form, setForm] = useState<ProfileForm>(() =>
    profile ? profileFormFor(profile) : newProfileForm(),
  );
  const [initialForm, setInitialForm] = useState<ProfileForm>(() =>
    profile ? profileFormFor(profile) : newProfileForm(),
  );
  const [errors, setErrors] = useState<ProfileFormErrors>({});
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const [savedNotice, setSavedNotice] = useState<boolean>(flashSaved);
  /**
   * The store revision this draft was opened against, fixed at mount and
   * advanced only by a successful save or an explicit reload. Background
   * refreshes of the shared cache must not move it, or a later save would
   * silently clobber the changes the refresh brought in.
   */
  const [baseRevision, setBaseRevision] = useState<string>(
    () => data.state?.revision ?? "",
  );
  const reconcile = async (): Promise<void> => {
    // An explicit reload re-anchors the draft to the current store; the text
    // the user typed stays and the next save is judged against it.
    try {
      const fresh = await data.refresh();
      if (fresh) {
        setBaseRevision(fresh.revision);
      }
      setStale(false);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : "The profiles could not be reloaded. Try again.",
      );
    }
  };
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  /** Save stays disabled until the draft differs from what it was opened with. */
  const dirty = profileFormKey(form) !== profileFormKey(initialForm);
  const set = (field: keyof ProfileForm) => (value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setSavedNotice(false);
  };
  const patch = (changes: Partial<ProfileForm>): void => {
    setForm((current) => ({ ...current, ...changes }));
    setSavedNotice(false);
  };
  const routingRef = useRef<View>(null);
  /** Latest form for the focus target decision, without effect churn. */
  const formRef = useRef(form);
  formRef.current = form;
  const focusRouting = useCallback((): void => {
    const section = routingElement(routingRef);
    if (!section) {
      return;
    }
    const current = formRef.current;
    // A profile without roles gets a role chip; otherwise the size control,
    // so the control that can unblock routing takes the focus.
    let selector = '[data-testid^="profile-role-"]';
    if (current.roles.length > 0) {
      if (current.size === "") {
        selector = '[data-testid^="profile-segment-"]';
      } else {
        selector = `[data-testid="profile-segment-${current.size}"]`;
      }
    }
    const target =
      section.querySelector?.(selector) ??
      section.querySelector?.('[data-testid^="profile-role-"]');
    section.scrollIntoView?.({ block: "nearest" });
    target?.focus?.();
  }, []);
  // The hint value at mount never re-triggers; only later changes do.
  const [mountedHint] = useState(routingHint);
  useEffect(() => {
    if (mountedHint !== undefined) {
      focusRouting();
    }
  }, [mountedHint, focusRouting]);
  useEffect(() => {
    if (routingHint !== undefined && routingHint !== mountedHint) {
      focusRouting();
    }
  }, [routingHint, mountedHint, focusRouting]);

  const submit = async (): Promise<void> => {
    const nextErrors = validateProfileForm(form, allProfiles);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }
    let draft: ProfileDraft;
    try {
      draft = profileDraftFromForm(form);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The profile is not valid.",
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await data.save(draft, baseRevision);
      if (result.status !== "saved") {
        setStale(true);
        return;
      }
      // Only a successful save advances the draft's base revision.
      setBaseRevision(result.state.revision);
      setStale(false);
      const savedId = result.profileId ?? form.id;
      if (savedId && onCreated && form.id === undefined) {
        onCreated(savedId);
        return;
      }
      // Re-anchor the draft so Save disables again until the next change.
      const savedForm = {
        ...form,
        ...(savedId ? { id: savedId } : {}),
        name: draft.name,
        notes: draft.notes,
        provider: draft.provider,
        model: draft.model ?? "",
        thinkingOptionId: draft.thinkingOptionId ?? "",
        modeId: draft.modeId ?? "",
        instructions: draft.instructions,
      };
      setForm(savedForm);
      setInitialForm(savedForm);
      setSavedNotice(true);
      session.update({ profileSelection: savedForm.id ?? null });
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : "The profile could not be saved. Reload and try again.",
      );
    } finally {
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!form.id) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await data.remove(form.id, baseRevision);
      if (result.status !== "saved") {
        setStale(true);
        return;
      }
      setBaseRevision(result.state.revision);
      session.update({ profileSelection: null });
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : "The profile could not be deleted. Reload and try again.",
      );
    } finally {
      setSaving(false);
      setConfirmingDelete(false);
    }
  };

  const duplicate = (): void => {
    if (!profile) {
      return;
    }
    // Duplicating reopens the editor as a create with copied fields and a
    // copy-suffixed name; the id is dropped so the store assigns a fresh one.
    const copy = duplicateProfileForm(profile);
    setForm(copy);
    setInitialForm(copy);
    setErrors({});
    setStale(false);
    setSavedNotice(false);
    setError(null);
  };

  const cancel = (): void => {
    setErrors({});
    setStale(false);
    setSavedNotice(false);
    setError(null);
    setConfirmingDelete(false);
    if (form.id === undefined) {
      onClosed?.();
      return;
    }
    // An existing draft goes back to the stored value it was opened with.
    setForm(initialForm);
    setErrors({});
  };

  const entry = data.providers?.providers.find(
    (provider) => provider.id === form.provider,
  );
  const modelEntry = entry?.models.find((model) => model.id === form.model);
  const providerOptions: readonly PickerOption[] =
    data.providers?.providers.map((provider) => ({
      value: provider.id,
      label: provider.label,
      detail: provider.available ? undefined : "unavailable",
    })) ?? [];
  const modelOptions: readonly PickerOption[] =
    entry?.models.map((model) => ({
      value: model.id,
      label: model.label,
      detail: model.isDefault ? "default" : undefined,
    })) ?? [];
  const thinkingOptions: readonly PickerOption[] =
    modelEntry?.thinkingOptions.map((option) => ({
      value: option.id,
      label: option.label,
      detail: option.isDefault ? "default" : undefined,
    })) ?? [];
  const modeOptions: readonly PickerOption[] =
    entry?.modes.map((item) => ({
      value: item.id,
      label: item.label,
      detail: item.elevated ? "elevated" : undefined,
    })) ?? [];
  const knownMode = entry?.modes.find((item) => item.id === form.modeId);
  // A duplicated draft has no id until the store assigns one on save.
  const isCreate = form.id === undefined;
  // Pickers only apply when the provider is known; otherwise free text keeps
  // imported or untouched profiles editable without a loaded catalog entry.
  const pickable = entry !== undefined;
  const ceilingHelper = knownMode?.description
    ? `${knownMode.description} The Conductor's own permission ceiling always applies.`
    : "The Conductor's own permission ceiling always applies.";

  return (
    <ScrollView
      testID="profile-editor"
      style={{ flex: 1, minHeight: 0 }}
      contentContainerStyle={{
        padding: 18,
        gap: 14,
        paddingBottom: 48,
        maxWidth: 640,
      }}
    >
      <View style={{ gap: 3 }}>
        <Text
          testID="profile-editor-title"
          style={{
            color: theme.colors.foreground,
            fontSize: 19,
            lineHeight: 26,
            fontWeight: "600",
          }}
        >
          {isCreate ? "New profile" : (profile?.name ?? form.name)}
        </Text>
        <Text
          numberOfLines={1}
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 11,
            lineHeight: 15,
            fontVariant: ["tabular-nums"],
          }}
        >
          {isCreate
            ? "The store assigns the id on the first save."
            : (profile?.id ?? "")}
        </Text>
      </View>
      {stale && (
        <StatusNotice
          theme={theme}
          tone="warning"
          testID="profile-stale-notice"
          action={
            <Button
              theme={theme}
              testID="profile-stale-reload"
              dense={!compact}
              label="Reload profiles"
              onPress={() => {
                reconcile().catch(() => undefined);
              }}
            />
          }
        >
          {STALE_SAVE_MESSAGE}
        </StatusNotice>
      )}
      {savedNotice && !stale && (
        <StatusNotice
          theme={theme}
          tone="success"
          testID="profile-saved-notice"
          onDismiss={() => setSavedNotice(false)}
        >
          Profile saved.
        </StatusNotice>
      )}
      {error && (
        <Text
          accessibilityRole="alert"
          testID="profile-save-error"
          style={{
            color: theme.colors.statusDanger,
            fontSize: 12,
            lineHeight: 17,
          }}
        >
          {error}
        </Text>
      )}
      <Field theme={theme} field="name" label="Name" error={errors.name}>
        <Input
          theme={theme}
          label="Profile name"
          testID="profile-name-input"
          value={form.name}
          onChangeText={set("name")}
          error={errors.name}
        />
      </Field>
      <Field
        theme={theme}
        field="provider"
        label="Provider"
        error={errors.provider}
        helper={
          providerOptions.length > 0
            ? undefined
            : "The provider catalog is not loaded; the id is kept as typed."
        }
      >
        {providerOptions.length > 0 ? (
          <ProfilePicker
            theme={theme}
            label="Provider"
            options={providerOptions}
            value={form.provider}
            compact={compact}
            testID="profile-provider-picker"
            error={Boolean(errors.provider)}
            onSelect={(value) =>
              patch({
                // A provider change invalidates its bound child choices.
                provider: value,
                ...(form.model || form.modeId || form.thinkingOptionId
                  ? { model: "", modeId: "", thinkingOptionId: "" }
                  : {}),
              })
            }
          />
        ) : (
          <Input
            theme={theme}
            label="Provider"
            testID="profile-provider-input"
            value={form.provider}
            onChangeText={set("provider")}
            error={errors.provider}
          />
        )}
      </Field>
      {pickable ? (
        <>
          <Field theme={theme} field="model" label="Model" error={errors.model}>
            <ProfilePicker
              theme={theme}
              label="Model"
              options={modelOptions}
              value={form.model}
              compact={compact}
              testID="profile-model-picker"
              onSelect={(value) =>
                patch({
                  model: value,
                  // Thinking options belong to one model; reset on change.
                  ...(modelEntry?.id === value ? {} : { thinkingOptionId: "" }),
                })
              }
            />
          </Field>
          <Field
            theme={theme}
            field="modeId"
            label="Mode"
            error={errors.modeId}
            helper={ceilingHelper}
          >
            <ProfilePicker
              theme={theme}
              label="Mode"
              options={modeOptions}
              value={form.modeId}
              compact={compact}
              testID="profile-mode-picker"
              onSelect={(value) => patch({ modeId: value })}
            />
          </Field>
          <Field
            theme={theme}
            field="thinkingOptionId"
            label="Thinking"
            error={errors.thinkingOptionId}
          >
            <ProfilePicker
              theme={theme}
              label="Thinking"
              options={thinkingOptions}
              value={form.thinkingOptionId}
              compact={compact}
              testID="profile-thinking-picker"
              onSelect={(value) => patch({ thinkingOptionId: value })}
            />
          </Field>
        </>
      ) : (
        <>
          <Field
            theme={theme}
            field="model"
            label="Model"
            helper="Not offered by the provider catalog; kept exactly as typed."
          >
            <Input
              theme={theme}
              label="Model"
              testID="profile-model-input"
              value={form.model}
              onChangeText={set("model")}
            />
          </Field>
          <Field
            theme={theme}
            field="modeId"
            label="Mode"
            helper={ceilingHelper}
          >
            <Input
              theme={theme}
              label="Mode"
              testID="profile-mode-input"
              value={form.modeId}
              onChangeText={set("modeId")}
            />
          </Field>
          <Field theme={theme} field="thinkingOptionId" label="Thinking">
            <Input
              theme={theme}
              label="Thinking"
              testID="profile-thinking-input"
              value={form.thinkingOptionId}
              onChangeText={set("thinkingOptionId")}
            />
          </Field>
        </>
      )}
      <Field
        theme={theme}
        field="notes"
        label="When to use"
        error={errors.notes}
        helper="Helps the Conductor choose this profile."
      >
        <Input
          theme={theme}
          label="When to use"
          testID="profile-notes-input"
          multiline
          minHeight={64}
          value={form.notes}
          onChangeText={set("notes")}
          error={errors.notes}
        />
      </Field>
      <View ref={routingRef}>
        <Section theme={theme} title="Routing" />
        <Field theme={theme} field="roles" label="Roles">
          <View style={[{ gap: 8 }]}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {PROFILE_ROLES.map((role) => (
                <RoleChip
                  key={role}
                  theme={theme}
                  role={role}
                  selected={form.roles.includes(role)}
                  onToggle={() =>
                    patch({
                      roles: form.roles.includes(role)
                        ? form.roles.filter((held) => held !== role)
                        : [...form.roles, role],
                    })
                  }
                />
              ))}
            </View>
            <Text
              testID="profile-roles-note"
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 11,
                lineHeight: 15,
              }}
            >
              {form.roles.length > 0
                ? `Routing considers this profile for ${form.roles.length === 1 ? "one role" : `${form.roles.length} roles`}${form.size ? " and its size" : " once a size is set"}.`
                : `Routing never picks this profile. Enforce routing is ${mode === "strict" ? "on" : "off"}.`}
            </Text>
          </View>
        </Field>
        <Field
          theme={theme}
          field="size"
          label="Size"
          helper="Your rating of the model's cost and strength. For a role, the Conductor tries smaller sizes first."
        >
          <View style={{ marginTop: 4 }}>
            <Segmented
              theme={theme}
              compact={compact}
              allowClear
              options={PROFILE_SIZES.map((size) => ({
                value: size,
                label: SIZE_LABELS[size] ?? size,
                accessibilityLabel: `${SIZE_LABELS[size] ?? size} size`,
              }))}
              value={form.size}
              onChange={(size) => patch({ size })}
            />
          </View>
        </Field>
      </View>
      <Section theme={theme} title="Instructions" />
      <Field
        theme={theme}
        field="instructions"
        label="Instructions"
        error={errors.instructions}
        helper="Delivered to every task agent using this profile. Put skill names here."
      >
        <Input
          theme={theme}
          label="Instructions"
          testID="profile-instructions-input"
          multiline
          minHeight={110}
          value={form.instructions}
          onChangeText={set("instructions")}
          error={errors.instructions}
        />
      </Field>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {profile && !isCreate && (
          <>
            <Button
              theme={theme}
              testID="profile-duplicate"
              dense={!compact}
              label="Duplicate"
              icon="Copy"
              disabled={saving}
              onPress={duplicate}
            />
            {confirmingDelete ? (
              <Button
                theme={theme}
                testID="profile-delete-confirm"
                dense={!compact}
                danger
                label="Confirm delete"
                disabled={saving}
                onPress={() => {
                  remove().catch(() => undefined);
                }}
              />
            ) : (
              <Button
                theme={theme}
                testID="profile-delete"
                dense={!compact}
                danger
                label="Delete"
                disabled={saving}
                onPress={() => setConfirmingDelete(true)}
              />
            )}
          </>
        )}
        <View style={{ flex: 1, minWidth: 8 }} />
        <Button
          theme={theme}
          testID="profile-cancel"
          dense={!compact}
          label="Cancel"
          disabled={saving}
          onPress={cancel}
        />
        <Button
          theme={theme}
          testID="profile-save"
          dense={!compact}
          primary
          label="Save"
          disabled={saving || (!dirty && form.id !== undefined)}
          onPress={() => {
            submit().catch(() => undefined);
          }}
        />
      </View>
      {confirmingDelete && (
        <View accessibilityRole="alert" testID="profile-delete-warning">
          <TintedView
            color={theme.colors.statusDanger}
            opacity={0.14}
            style={{ borderRadius: 10 }}
          >
            <Text
              style={{
                color: theme.colors.statusDanger,
                fontSize: 12,
                lineHeight: 18,
                padding: 10,
              }}
            >
              Deleting removes this profile from the store. Press Confirm delete
              again to remove it.
            </Text>
          </TintedView>
        </View>
      )}
    </ScrollView>
  );
}
