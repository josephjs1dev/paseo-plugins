import type { RpcInput } from "@getpaseo/plugin";
import type { answerRequest } from "../../shared/agents/rpc";
import type { AnswerResult, Receipt } from "../../shared/agents/models";
import { questionAnswers, requestForm } from "../../shared/agents/questions";
import { digest, requestKey } from "./identity";
import type { AgentPermissionResponse } from "../../shared/agents/agent";
import type { AgentsHost } from "./host";
import type { AgentsStore } from "./store";

/** Fresh server inspection + an exclusive on-disk claim fence every permission response. */
export async function answer(
  runtime: AgentsHost,
  store: AgentsStore,
  input: RpcInput<typeof answerRequest>,
  now = Date.now(),
): Promise<AnswerResult> {
  const previous = await store.receipt(input.key);
  const decisionDigest = digest(input.decision);
  if (previous) {
    if (
      previous.agentId !== input.agentId ||
      previous.requestId !== input.requestId
    ) {
      return { status: "stale" };
    }
    if (previous.digest !== decisionDigest) {
      return { status: "unknown" };
    }
    return { status: previous.status === "answered" ? "answered" : "unknown" };
  }
  const agent = await runtime.inspect(input.agentId);
  if (!agent || agent.archived) {
    return { status: "stale" };
  }
  const request = agent.pendingPermissions.find(
    (candidate) => candidate.id === input.requestId,
  );
  if (!request || requestKey(agent, request) !== input.key) {
    return { status: "stale" };
  }
  if (agent.status === "error" || agent.status === "closed") {
    return { status: "unsupported" };
  }
  const form = requestForm(request);
  let response: AgentPermissionResponse;
  if (form.kind === "questions") {
    const answers = questionAnswers(form, input.decision);
    if (!answers) {
      return { status: "unsupported" };
    }
    response = {
      behavior: "allow",
      updatedInput: { ...request.input, answers },
    };
  } else if (form.kind === "actions" && input.decision.kind === "action") {
    const selectedId = input.decision.actionId;
    const selected = form.actions.find((action) => action.id === selectedId);
    if (!selected) {
      return { status: "unsupported" };
    }
    response = {
      behavior: selected.behavior,
      ...(request.actions ? { selectedActionId: selected.id } : {}),
    };
  } else {
    return { status: "unsupported" };
  }
  const receipt: Receipt = {
    key: input.key,
    agentId: input.agentId,
    requestId: input.requestId,
    digest: decisionDigest,
    status: "sending",
    at: now,
  };
  if (!(await store.claim(receipt))) {
    return { status: "unknown" };
  }
  try {
    await runtime.answer(input.agentId, input.requestId, response);
    await store.complete({ ...receipt, status: "answered", at: Date.now() });
    return { status: "answered" };
  } catch {
    // Failure after dispatch cannot establish whether the native provider consumed the answer.
    await store
      .complete({ ...receipt, status: "unknown" })
      .catch(() => undefined);
    return { status: "unknown" };
  }
}
