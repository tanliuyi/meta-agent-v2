import type { QuestionParams, QuestionnaireResult } from "./tool/types";

/** Optional structured host capability; terminal/RPC Pi keep their existing UI path. */
export interface QuestionnaireUI {
  questionnaire(input: QuestionParams, options?: { signal?: AbortSignal }): Promise<QuestionnaireResult>;
}

export function hasQuestionnaireUI(ui: unknown): ui is QuestionnaireUI {
  return typeof (ui as Partial<QuestionnaireUI> | null)?.questionnaire === "function";
}
