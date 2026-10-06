import { z } from "zod";
import { graphIssues } from "../shared/run-graph";
import {
  RUN_LIMITS,
  contextSchema,
  graphSchema,
  runIdSchema,
  sourceSchema,
  type RunGraph,
} from "../shared/run-models";
import { RunError } from "../server/run-files";
import type { RunPlacementRuntime } from "../server/run-placement";
import { contentHash, type RunStore } from "../server/run-store";

// Test-only builder for snapshots written by the retired manual planner.
const prepareRunInput = z
  .object({
    id: runIdSchema,
    title: z.string().trim().min(1).max(160),
    source: sourceSchema,
    context: contextSchema,
    graph: graphSchema,
  })
  .strict();
const runCommandInput = z
  .object({
    id: runIdSchema,
    expectedVersion: z.number().int().nonnegative(),
    command: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("save-draft"), graph: graphSchema }).strict(),
      z
        .object({
          kind: z.literal("accept"),
          reason: z.string().trim().min(1).max(2000),
        })
        .strict(),
      z.object({ kind: z.literal("discard-draft") }).strict(),
    ]),
  })
  .strict();
function requireValidGraph(graph: RunGraph): void {
  const issues = graphIssues(graph);
  if (issues.length) {
    throw new RunError(issues.slice(0, 5).join(" "));
  }
}

export function legacyRunService(
  store: RunStore,
  runtime: RunPlacementRuntime,
) {
  return {
    async prepare(input: z.infer<typeof prepareRunInput>) {
      const parsed = prepareRunInput.parse(input);
      requireValidGraph(parsed.graph);
      const source = await runtime.capture(parsed.source);
      await runtime.validate(source, parsed.graph);
      const now = Date.now();
      return store.create(
        {
          schemaVersion: 1,
          id: parsed.id,
          version: 0,
          title: parsed.title,
          source,
          contextHash: contentHash(JSON.stringify(parsed.context)),
          requestHash: contentHash(JSON.stringify(parsed)),
          createdAt: now,
          updatedAt: now,
          status: "draft",
          execution: null,
          draft: parsed.graph,
          revisions: [],
        },
        parsed.context,
      );
    },
    async change(input: z.infer<typeof runCommandInput>) {
      const parsed = runCommandInput.parse(input);
      return store.update(parsed.id, parsed.expectedVersion, async (run) => {
        if (run.execution) {
          throw new RunError(
            "Agent-owned runs are updated through their source commands.",
          );
        }
        switch (parsed.command.kind) {
          case "save-draft": {
            requireValidGraph(parsed.command.graph);
            await runtime.validate(run.source, parsed.command.graph);
            return { ...run, draft: parsed.command.graph };
          }
          case "discard-draft": {
            if (!run.revisions.length) {
              throw new RunError("An unaccepted run must keep its draft.");
            }
            return { ...run, draft: null };
          }
          case "accept": {
            if (!run.draft?.tasks.length) {
              throw new RunError(
                "Add at least one task before accepting the breakdown.",
              );
            }
            if (run.revisions.length >= RUN_LIMITS.revisions) {
              throw new RunError(
                "This run has reached its accepted revision limit.",
              );
            }
            requireValidGraph(run.draft);
            await runtime.validate(run.source, run.draft);
            // Acceptance records an operator's plan decision; there is no dispatch authorization in milestone A.
            return {
              ...run,
              status: "accepted",
              draft: null,
              revisions: [
                ...run.revisions,
                {
                  number: run.revisions.length + 1,
                  parent: run.revisions.at(-1)?.number ?? null,
                  reason: parsed.command.reason,
                  acceptedAt: Date.now(),
                  authority: "operator",
                  graph: run.draft,
                },
              ],
            };
          }
        }
      });
    },
  };
}
