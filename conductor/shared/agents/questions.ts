import { z } from "zod";
import { formSchema, type Decision, type RequestForm } from "./models";

const rawQuestions = z.object({
  questions: z
    .array(
      z.object({
        header: z.string().min(1).max(200),
        question: z.string().min(1).max(8000),
        options: z
          .array(
            z.object({
              label: z.string().min(1).max(1000),
              description: z.string().max(4000).optional(),
            }),
          )
          .max(30),
        multiSelect: z.boolean().optional(),
        allowOther: z.boolean().optional(),
        isOther: z.boolean().optional(),
        allowEmpty: z.boolean().optional(),
        isSecret: z.literal(false).optional(),
      }),
    )
    .min(1)
    .max(12),
});
const rawActions = z
  .array(
    z.object({
      id: z.string().min(1).max(512),
      label: z.string().min(1).max(1000),
      behavior: z.enum(["allow", "deny"]),
    }),
  )
  .min(1)
  .max(12);
export interface NativeRequestShape {
  kind: string;
  input?: unknown;
  actions?: unknown;
}

/** Accept only the normalized question format used by Paseo's own question form. */
export function requestForm(request: NativeRequestShape): RequestForm {
  const fallback: RequestForm = {
    kind: "native",
    reason: "Open this request in the agent to use its native controls.",
  };
  if (request.kind === "question") {
    const parsed = rawQuestions.safeParse(request.input);
    if (!parsed.success) {
      return fallback;
    }
    const headers = parsed.data.questions.map((question) => question.header);
    if (new Set(headers).size !== headers.length) {
      return fallback;
    }
    return formSchema.parse({
      kind: "questions",
      questions: parsed.data.questions.map((question) => ({
        ...question,
        options: question.options.map((option) => ({
          ...option,
          description: option.description ?? "",
        })),
        multiSelect: question.multiSelect === true,
        allowOther:
          question.allowOther === true ||
          question.isOther === true ||
          question.options.length === 0,
        allowEmpty: question.allowEmpty === true,
      })),
    });
  }
  if (request.kind !== "tool") {
    return fallback;
  }
  if (request.actions !== undefined) {
    const actions = rawActions.safeParse(request.actions);
    if (
      !actions.success ||
      new Set(actions.data.map((action) => action.id)).size !==
        actions.data.length
    ) {
      return fallback;
    }
    return { kind: "actions", actions: actions.data };
  }
  return {
    kind: "actions",
    actions: [
      { id: "conductor-allow-once", label: "Allow once", behavior: "allow" },
      { id: "conductor-deny", label: "Deny", behavior: "deny" },
    ],
  };
}

export function questionAnswers(
  form: RequestForm,
  decision: Decision,
): Record<string, string> | null {
  if (
    form.kind !== "questions" ||
    decision.kind !== "answers" ||
    form.questions.length !== decision.answers.length
  ) {
    return null;
  }
  const entries: [string, string][] = [];
  for (const [index, question] of form.questions.entries()) {
    const answer = decision.answers[index];
    if (!answer || new Set(answer.selected).size !== answer.selected.length) {
      return null;
    }
    if (!question.multiSelect && answer.selected.length > 1) {
      return null;
    }
    const labels: string[] = [];
    for (const selected of answer.selected) {
      const option = question.options[selected];
      if (!option) {
        return null;
      }
      labels.push(option.label);
    }
    const text = answer.text.trim();
    if (text && !question.allowOther) {
      return null;
    }
    let value = labels.join(", ");
    if (text) {
      value = question.multiSelect ? [...labels, text].join(", ") : text;
    }
    if (!value && !(question.allowEmpty && question.allowOther)) {
      return null;
    }
    entries.push([question.header, value]);
  }
  return Object.fromEntries(entries);
}
