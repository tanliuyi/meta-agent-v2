import type {
  QuestionnaireAnswer,
  QuestionnaireInput,
  QuestionnaireQuestion,
  QuestionnaireResult,
} from "../../../../../shared/questionnaire-contracts.ts";

export interface QuestionnaireDraft {
  selected: number[];
  custom: boolean;
  text: string;
  notes: string;
  confirmed: boolean;
}

export function createQuestionnaireDrafts(input: QuestionnaireInput): QuestionnaireDraft[] {
  return input.questions.map(() => ({ selected: [], custom: false, text: "", notes: "", confirmed: false }));
}

export function draftAnswer(
  question: QuestionnaireQuestion,
  questionIndex: number,
  draft: QuestionnaireDraft,
): QuestionnaireAnswer | undefined {
  const base = { questionIndex, question: question.question, ...(draft.notes.trim() ? { notes: draft.notes } : {}) };
  if (draft.custom) {
    return draft.text.trim() ? { ...base, kind: "custom", answer: draft.text } : undefined;
  }
  if (question.multiSelect) {
    return draft.confirmed || draft.selected.length > 0
      ? { ...base, kind: "multi", answer: null, selected: draft.selected.map((index) => question.options[index].label) }
      : undefined;
  }
  const option = question.options[draft.selected[0]];
  return option
    ? { ...base, kind: "option", answer: option.label, ...(option.preview ? { preview: option.preview } : {}) }
    : undefined;
}

export function questionnaireResult(
  input: QuestionnaireInput,
  drafts: QuestionnaireDraft[],
  globalNote: string,
  cancelled: boolean,
): QuestionnaireResult {
  const answers = input.questions.flatMap((question, index) => {
    const draft = drafts[index];
    const answer = draftAnswer(question, index, draft);
    if (answer) return [answer];
    if (cancelled && draft.notes.trim()) {
      return [
        {
          questionIndex: index,
          question: question.question,
          kind: "custom" as const,
          answer: null,
          notes: draft.notes,
        },
      ];
    }
    return [];
  });
  if (!cancelled && answers.length !== input.questions.length) throw new Error("请完成所有问题后提交");
  return { answers, cancelled, ...(globalNote.trim() ? { globalNote } : {}) };
}
