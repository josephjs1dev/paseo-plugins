/**
 * Which worker a task or profile uses, resolved to display labels: the pure
 * data the graph nodes and the profile cards render. No React Native imports,
 * like routing.ts. Every lookup tolerates records stored before the launch
 * snapshot existed by falling through to the older worker sources, and an
 * unresolvable worker is the caller's `null` to render as it pleases.
 */
import type {
  Attempt,
  StoredSymphony,
  TaskDefinition,
} from "../../shared/symphonies/models";
import { latestAttempt } from "../../shared/symphonies/models";
import type { ConductorProfile } from "../../shared/symphonies/profiles";
import { resolveProfileRef } from "../../shared/symphonies/profiles";
import type { ProviderCatalog } from "../../shared/symphonies/profiles-rpc";

/** The worker identity a graph node or profile card renders. */
export interface WorkerIdentity {
  /** The provider id, e.g. "claude"; the mark lookup key. */
  provider: string | null;
  /** The catalog's provider label, falling back to the raw id. */
  providerLabel: string | null;
  /** The catalog's model label, falling back to the raw id. */
  modelLabel: string | null;
  /** The catalog's thinking-option label, falling back to the raw id. */
  thinkingLabel: string | null;
  /** Whether a launch actually ran on the worker or the task only plans it. */
  source: "launched" | "planned";
}

/**
 * Labels for a concrete worker through the provider catalog, mirroring the
 * profile card's worker line: an unknown provider, model or thinking option
 * shows its raw id instead of nothing.
 */
function catalogIdentity(
  provider: string,
  model: string | undefined,
  thinkingOptionId: string | undefined,
  catalog: ProviderCatalog | undefined,
): WorkerIdentity {
  const entry = catalog?.providers.find(
    (providerEntry) => providerEntry.id === provider,
  );
  const modelEntry = model
    ? entry?.models.find((modelEntry) => modelEntry.id === model)
    : undefined;
  const thinkingEntry = thinkingOptionId
    ? modelEntry?.thinkingOptions.find(
        (option) => option.id === thinkingOptionId,
      )
    : undefined;
  return {
    provider,
    providerLabel: entry?.label ?? provider,
    modelLabel: modelEntry?.label ?? model ?? null,
    thinkingLabel: thinkingEntry?.label ?? thinkingOptionId ?? null,
    source: "planned",
  };
}

/** The worker a profile names, as the profile card renders it. */
export function profileIdentity(
  profile: ConductorProfile,
  catalog: ProviderCatalog | undefined,
): WorkerIdentity {
  return catalogIdentity(
    profile.provider,
    profile.model,
    profile.thinkingOptionId,
    catalog,
  );
}

/**
 * The worker a task uses, resolved in one pass from the most authoritative
 * source down: the latest attempt's resolved launch snapshot (recorded since
 * the launch carried one), then its inline launch choice, then the task's
 * planned worker — an inline choice or the profile it names. Returns null
 * when nothing names a provider, as with an `inherit` launch.
 */
export function taskIdentity(
  symphony: StoredSymphony,
  task: TaskDefinition,
  profiles: readonly ConductorProfile[],
  catalog: ProviderCatalog | undefined,
): WorkerIdentity | null {
  const launch: Attempt["launch"] = latestAttempt(symphony, task.id)?.launch;
  // A profile launch's snapshot is what actually ran, surviving profile edits.
  if (launch?.resolved) {
    return {
      ...catalogIdentity(
        launch.resolved.provider,
        launch.resolved.model,
        launch.resolved.thinkingOptionId,
        catalog,
      ),
      source: "launched",
    };
  }
  // The inline fields mean "the Conductor chose an inline model"; "inherit"
  // is the sentinel for the Conductor's own worker, which has no identity here.
  if (launch?.provider && launch.provider !== "inherit") {
    return {
      ...catalogIdentity(
        launch.provider,
        launch.model,
        launch.thinkingOptionId,
        catalog,
      ),
      source: "launched",
    };
  }
  if (task.worker.provider) {
    return catalogIdentity(
      task.worker.provider,
      task.worker.model,
      task.worker.thinkingOptionId,
      catalog,
    );
  }
  const ref = task.worker.profile;
  if (!ref) {
    return null;
  }
  const resolution = resolveProfileRef(profiles, ref);
  return "profile" in resolution
    ? profileIdentity(resolution.profile, catalog)
    : null;
}

/** The identity as accessible text, e.g. "Claude Opus 5.5, Medium". */
export function identityLabel(identity: WorkerIdentity): string {
  return [identity.providerLabel, identity.modelLabel, identity.thinkingLabel]
    .filter(Boolean)
    .join(", ");
}
