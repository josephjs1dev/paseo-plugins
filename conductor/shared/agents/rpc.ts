import { defineRpc } from "@getpaseo/plugin";
import { identifier } from "../schema";
import { z } from "zod";
import {
  answerResultSchema,
  decisionSchema,
  keySchema,
  snapshotSchema,
  archiveResultSchema,
} from "./models";

export const getAgents = defineRpc({
  name: "inbox.get",
  input: z.object({ knownAgentIds: z.array(identifier).max(2000).default([]) }),
  output: snapshotSchema,
});
export const archiveAgent = defineRpc({
  name: "inbox.archive",
  input: z.object({ agentId: identifier, key: keySchema }),
  output: archiveResultSchema,
});
export const answerRequest = defineRpc({
  name: "inbox.answer",
  input: z.object({
    key: keySchema,
    agentId: identifier,
    requestId: identifier,
    decision: decisionSchema,
  }),
  output: answerResultSchema,
});
export const annotate = defineRpc({
  name: "inbox.annotate",
  input: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("snooze"),
      key: keySchema,
      minutes: z.union([z.literal(0), z.literal(15), z.literal(60)]),
    }),
    z.object({
      kind: z.literal("mark"),
      agentId: identifier,
      marked: z.boolean(),
    }),
  ]),
  output: z.object({}),
});
