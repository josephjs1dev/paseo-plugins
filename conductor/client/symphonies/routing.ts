/**
 * Render-only derivations for the routing decisions stored on task definitions
 * and attempt launches. Pure data with no React Native imports, like
 * history.ts: the task card, the report panel and History consume these
 * strings directly. Every function tolerates records stored before routing
 * existed by leaving their display to the caller's undefined checks.
 */
import type { Attempt, LoopReopen } from "../../shared/symphonies/models";
import type {
  AttemptRouting,
  RoutingOverrideCategory,
  RoutingSelectedBy,
  RoutingWarning,
  RoutingWarningCode,
} from "../../shared/symphonies/routing";

/** The worker fields a task definition, launch or reopen override carries. */
export interface WorkerSpec {
  profile?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  thinkingOptionId?: string | undefined;
}

/**
 * The worker fields a persisted launch carries, as a WorkerSpec for
 * `workerSelection` and `routingLine`.
 */
export function launchWorker(
  launch: Pick<
    NonNullable<Attempt["launch"]>,
    "profile" | "profileName" | "provider" | "model" | "thinkingOptionId"
  >,
): WorkerSpec {
  return {
    // The stored name snapshot keeps the line readable after a rename.
    profile: launch.profileName ?? launch.profile,
    ...(launch.provider !== undefined ? { provider: launch.provider } : {}),
    ...(launch.model !== undefined ? { model: launch.model } : {}),
    ...(launch.thinkingOptionId !== undefined
      ? { thinkingOptionId: launch.thinkingOptionId }
      : {}),
  };
}

/**
 * The worker fields a reopen override carries, as a WorkerSpec. A reopen may
 * name only a profile or only an inline provider/model.
 */
export function reopenWorker(
  worker: NonNullable<LoopReopen["worker"]>,
): WorkerSpec {
  // The stored name snapshot keeps the line readable after a rename.
  const ref: string | undefined = worker.profileName ?? worker.profile;
  return {
    ...(ref !== undefined ? { profile: ref } : {}),
    ...(worker.provider !== undefined ? { provider: worker.provider } : {}),
    ...(worker.model !== undefined ? { model: worker.model } : {}),
    ...(worker.thinkingOptionId !== undefined
      ? { thinkingOptionId: worker.thinkingOptionId }
      : {}),
  };
}

/**
 * The worker as the user reads it: "provider/model (thinking option)" for an
 * inline choice, otherwise the profile id. The server stores the "inherit"
 * sentinel alongside explicit inline fields for takeovers, so the inline
 * choice always wins; "inherit" alone means the launch used the Conductor's
 * own worker, and the label says so.
 */
export function workerSelection(worker: WorkerSpec): string {
  const inline = [
    [worker.provider, worker.model].filter(Boolean).join("/"),
    worker.thinkingOptionId ? `thinking ${worker.thinkingOptionId}` : "",
  ].filter(Boolean);
  if (inline.length) {
    return inline.join(", ");
  }
  if (worker.profile === "inherit") {
    return "the Conductor's worker";
  }
  return worker.profile ?? "unresolved";
}

/** How the worker was picked, leading the card and history routing lines. */
const SELECTED_BY: Record<RoutingSelectedBy, string> = {
  route: "Routed to",
  conductor: "Conductor chose",
  inherit: "Inherits",
};

/**
 * The one-line card summary: how the worker was picked, the worker itself,
 * and the stored selection reason. The reason is the Conductor's visible
 * justification and stays clamped to one line on the card.
 */
export function routingLine(
  routing: Pick<AttemptRouting, "reason" | "selectedBy">,
  worker: WorkerSpec,
): string {
  return `${SELECTED_BY[routing.selectedBy]} ${workerSelection(worker)} — ${routing.reason}`;
}

/** The words for a bypass category, used in the report and History panels. */
export const OVERRIDE_LABELS: Record<RoutingOverrideCategory, string> = {
  "user-choice": "User choice",
  "capability-gap": "Capability gap",
  "observed-limitation": "Observed limitation",
  "no-eligible-profile": "No eligible profile",
};

/** The override as one line, or null when the routing carried no override. */
export function overrideLine(
  routing: Pick<AttemptRouting, "override">,
): string | null {
  const override = routing.override;
  if (!override) {
    return null;
  }
  return `Override (${OVERRIDE_LABELS[override.category]}): ${override.evidence}`;
}

/** Short words per warning code; the message carries the specific detail. */
const WARNING_LABELS: Record<RoutingWarningCode, string> = {
  inherit: "Inherited worker",
  "unclassified-profile": "Unclassified profile",
  "larger-than-eligible": "Larger than eligible",
  "ineligible-profile": "Ineligible profile",
  "unconfigured-model": "Unconfigured model",
  "missing-reason": "Missing reason",
  "generic-override-evidence": "Generic override evidence",
  "invalid-override-category": "Invalid override category",
  "catalog-changed": "Catalog changed",
};

/** A warning as one readable line: short label, then the stored message. */
export function warningLine(warning: RoutingWarning): string {
  return `${WARNING_LABELS[warning.code]}: ${warning.message}`;
}

/**
 * The stored catalog revision as a short display form; the full 64-character
 * hash stays selectable nowhere because it is noise in a card. Returns null
 * for records stored before revisions were recorded.
 */
export function shortRevision(revision: string | undefined): string | null {
  return revision ? `${revision.slice(0, 12)}…` : null;
}
