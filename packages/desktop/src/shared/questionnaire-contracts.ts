/** Structured host UI capability. Field semantics match rpiv's TUI answer envelope. */
export interface QuestionnaireQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string; preview?: string }>;
  multiSelect?: boolean;
}

export interface QuestionnaireInput {
  questions: QuestionnaireQuestion[];
}

export interface QuestionnaireAnswer {
  questionIndex: number;
  question: string;
  kind: "option" | "custom" | "multi";
  answer: string | null;
  selected?: string[];
  notes?: string;
  preview?: string;
}

export interface QuestionnaireResult {
  answers: QuestionnaireAnswer[];
  cancelled: boolean;
  globalNote?: string;
}

export interface QuestionnaireUI {
  questionnaire(
    input: QuestionnaireInput,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<QuestionnaireResult>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateQuestionnaireInput(value: unknown): asserts value is QuestionnaireInput {
  if (!record(value) || !Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > 4) {
    throw new Error("A questionnaire requires 1-4 questions");
  }
  for (const question of value.questions) {
    if (
      !record(question) ||
      typeof question.question !== "string" ||
      typeof question.header !== "string" ||
      (question.multiSelect !== undefined && typeof question.multiSelect !== "boolean") ||
      !Array.isArray(question.options) ||
      question.options.length < 2 ||
      question.options.length > 4
    ) {
      throw new Error("Invalid questionnaire question");
    }
    const labels = new Set<string>();
    for (const option of question.options) {
      if (
        !record(option) ||
        typeof option.label !== "string" ||
        typeof option.description !== "string" ||
        (option.preview !== undefined && typeof option.preview !== "string") ||
        labels.has(option.label)
      ) {
        throw new Error("Invalid questionnaire option");
      }
      labels.add(option.label);
    }
  }
}

/** Validate renderer responses before settling the request; reconstruct authoritative question/preview text. */
export function readQuestionnaireResult(input: QuestionnaireInput, value: unknown): QuestionnaireResult {
  if (
    !record(value) ||
    typeof value.cancelled !== "boolean" ||
    !Array.isArray(value.answers) ||
    (value.globalNote !== undefined && typeof value.globalNote !== "string")
  ) {
    throw new Error("Invalid questionnaire response");
  }
  const seen = new Set<number>();
  const answers: QuestionnaireAnswer[] = value.answers.map((answer: unknown) => {
    if (
      !record(answer) ||
      typeof answer.questionIndex !== "number" ||
      !Number.isInteger(answer.questionIndex) ||
      seen.has(answer.questionIndex) ||
      (answer.notes !== undefined && typeof answer.notes !== "string")
    ) {
      throw new Error("Invalid questionnaire answer");
    }
    const question = input.questions[answer.questionIndex];
    if (!question) throw new Error("Unknown questionnaire question");
    seen.add(answer.questionIndex);
    const base = {
      questionIndex: answer.questionIndex,
      question: question.question,
      ...(typeof answer.notes === "string" && answer.notes.trim() ? { notes: answer.notes } : {}),
    };
    if (
      answer.kind === "custom" &&
      ((value.cancelled && answer.answer === null) ||
        (typeof answer.answer === "string" && answer.answer.trim().length > 0))
    ) {
      return { ...base, kind: "custom", answer: answer.answer };
    }
    if (answer.kind === "option" && !question.multiSelect) {
      const option = question.options.find((option) => option.label === answer.answer);
      if (option)
        return {
          ...base,
          kind: "option",
          answer: option.label,
          ...(option.preview ? { preview: option.preview } : {}),
        };
    }
    if (
      answer.kind === "multi" &&
      question.multiSelect &&
      Array.isArray(answer.selected) &&
      answer.selected.every(
        (label) => typeof label === "string" && question.options.some((option) => option.label === label),
      ) &&
      new Set(answer.selected).size === answer.selected.length
    ) {
      return { ...base, kind: "multi", answer: null, selected: answer.selected as string[] };
    }
    throw new Error("Questionnaire answer does not match offered options");
  });
  if (!value.cancelled && answers.length !== input.questions.length)
    throw new Error("Answer every question before submitting");
  answers.sort((a, b) => a.questionIndex - b.questionIndex);
  return {
    answers,
    cancelled: value.cancelled,
    ...(typeof value.globalNote === "string" && value.globalNote.trim() ? { globalNote: value.globalNote } : {}),
  };
}
