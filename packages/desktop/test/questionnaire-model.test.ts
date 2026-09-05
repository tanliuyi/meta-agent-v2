import { describe, expect, it } from "vitest";
import {
  createQuestionnaireDrafts,
  draftAnswer,
  questionnaireResult,
} from "../src/renderer/src/components/chat/composer/questionnaire-model.ts";
import type { QuestionnaireInput } from "../src/shared/questionnaire-contracts.ts";
import { readQuestionnaireResult } from "../src/shared/questionnaire-contracts.ts";

const input: QuestionnaireInput = {
  questions: [
    {
      question: "Select any",
      header: "Options",
      multiSelect: true,
      options: [
        { label: "A", description: "First" },
        { label: "B", description: "Second" },
      ],
    },
  ],
};

describe("questionnaire model", () => {
  it("serializes an explicitly confirmed empty multi-select answer", () => {
    const [draft] = createQuestionnaireDrafts(input);
    const confirmed = { ...draft, confirmed: true };

    expect(draftAnswer(input.questions[0], 0, confirmed)).toEqual({
      questionIndex: 0,
      question: "Select any",
      kind: "multi",
      answer: null,
      selected: [],
    });
    expect(questionnaireResult(input, [confirmed], "", false)).toMatchObject({ cancelled: false });
  });

  it("preserves notes from unanswered questions when cancelled", () => {
    const [draft] = createQuestionnaireDrafts(input);

    expect(questionnaireResult(input, [{ ...draft, notes: "Context" }], "Global", true)).toEqual({
      answers: [
        {
          questionIndex: 0,
          question: "Select any",
          kind: "custom",
          answer: null,
          notes: "Context",
        },
      ],
      cancelled: true,
      globalNote: "Global",
    });
  });
});

describe("questionnaire response validation", () => {
  it.each([null, "", "   "])("rejects an unanswered custom response: %j", (answer) => {
    expect(() =>
      readQuestionnaireResult(input, {
        cancelled: false,
        answers: [{ questionIndex: 0, kind: "custom", answer }],
      }),
    ).toThrow("Questionnaire answer does not match offered options");
  });

  it("rejects missing and duplicate answers", () => {
    expect(() => readQuestionnaireResult(input, { cancelled: false, answers: [] })).toThrow(
      "Answer every question before submitting",
    );
    expect(() =>
      readQuestionnaireResult(input, {
        cancelled: false,
        answers: [
          { questionIndex: 0, kind: "multi", answer: null, selected: [] },
          { questionIndex: 0, kind: "multi", answer: null, selected: [] },
        ],
      }),
    ).toThrow("Invalid questionnaire answer");
  });

  it("allows a null custom placeholder only when cancelled", () => {
    expect(
      readQuestionnaireResult(input, {
        cancelled: true,
        answers: [{ questionIndex: 0, kind: "custom", answer: null, notes: "Context" }],
      }),
    ).toMatchObject({ cancelled: true, answers: [{ answer: null, notes: "Context" }] });
  });
});
