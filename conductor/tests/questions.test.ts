import assert from "node:assert/strict";
import { test } from "node:test";
import { questionAnswers, requestForm } from "../shared/questions";
import { question } from "./fixtures";

await test("free text, single selection, and multiple selections use native header-keyed answers", () => {
  const form = requestForm(question());
  assert.deepEqual(
    questionAnswers(form, {
      kind: "answers",
      answers: [{ selected: [0], text: "Custom" }],
    }),
    { Pagination: "Custom" },
  );
  const multiple = requestForm(
    question({
      input: {
        questions: [
          {
            header: "Options",
            question: "Which?",
            options: [{ label: "A" }, { label: "B" }],
            multiSelect: true,
            allowOther: true,
          },
        ],
      },
    }),
  );
  assert.deepEqual(
    questionAnswers(multiple, {
      kind: "answers",
      answers: [{ selected: [0, 1], text: "C" }],
    }),
    { Options: "A, B, C" },
  );
});
await test("unsupported, secret, and duplicate-header forms fall back to native controls", () => {
  for (const input of [
    { questions: [] },
    {
      questions: [
        { question: "Secret", header: "Key", options: [], isSecret: true },
      ],
    },
    {
      questions: [
        { question: "A", header: "same", options: [] },
        { question: "B", header: "same", options: [] },
      ],
    },
  ]) {
    assert.equal(requestForm(question({ input })).kind, "native");
  }
  assert.equal(requestForm(question({ kind: "mode" })).kind, "native");
  assert.equal(
    requestForm(
      question({
        provider: "claude",
        kind: "plan",
        input: { plan: "Review this plan" },
      }),
    ).kind,
    "native",
  );
});
await test("invalid selections, mismatched counts, and missing required answers are rejected", () => {
  const form = requestForm(question());
  for (const answers of [
    [],
    [{ selected: [], text: "" }],
    [{ selected: [0, 1], text: "" }],
    [{ selected: [0, 0], text: "" }],
    [{ selected: [30], text: "" }],
  ]) {
    assert.equal(questionAnswers(form, { kind: "answers", answers }), null);
  }
});
await test("blank free text is accepted only when explicitly allowed", () => {
  const form = requestForm(
    question({
      input: {
        questions: [
          {
            header: "Note",
            question: "Optional note",
            options: [],
            allowEmpty: true,
          },
        ],
      },
    }),
  );
  assert.deepEqual(
    questionAnswers(form, {
      kind: "answers",
      answers: [{ selected: [], text: "" }],
    }),
    { Note: "" },
  );
});
