import { z } from "zod";
import { graphIssues } from "../shared/concerts/graph";
import {
  CONCERT_LIMITS,
  contextSchema,
  graphSchema,
  uuidSchema,
  sourceSchema,
  type ConcertGraph,
} from "../shared/concerts/models";
import { ConcertError } from "../server/concerts/errors";
import type { ConcertPlacementRuntime } from "../server/concerts/placement";
import { contentHash, type ConcertStore } from "../server/concerts/store";

// Test-only builder for snapshots written by the retired manual planner.
const prepareConcertInput = z
  .object({
    id: uuidSchema,
    title: z.string().trim().min(1).max(160),
    source: sourceSchema,
    context: contextSchema,
    graph: graphSchema,
  })
  .strict();
const concertCommandInput = z
  .object({
    id: uuidSchema,
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
function requireValidGraph(graph: ConcertGraph): void {
  const issues = graphIssues(graph);
  if (issues.length) {
    throw new ConcertError(issues.slice(0, 5).join(" "));
  }
}

export function legacyConcertService(
  store: ConcertStore,
  runtime: ConcertPlacementRuntime,
) {
  return {
    async prepare(input: z.infer<typeof prepareConcertInput>) {
      const parsed = prepareConcertInput.parse(input);
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
    async change(input: z.infer<typeof concertCommandInput>) {
      const parsed = concertCommandInput.parse(input);
      return store.update(parsed.id, parsed.expectedVersion, async (run) => {
        if (run.execution) {
          throw new ConcertError(
            "Agent-owned concerts are updated through their source commands.",
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
              throw new ConcertError(
                "An unaccepted concert must keep its draft.",
              );
            }
            return { ...run, draft: null };
          }
          case "accept": {
            if (!run.draft?.tasks.length) {
              throw new ConcertError(
                "Add at least one task before accepting the breakdown.",
              );
            }
            if (run.revisions.length >= CONCERT_LIMITS.revisions) {
              throw new ConcertError(
                "This concert has reached its accepted revision limit.",
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
