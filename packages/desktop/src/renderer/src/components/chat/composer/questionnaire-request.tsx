import { Button } from "@renderer/shared/ui/button";
import { useState } from "react";
import type { HostRequest } from "../../../../../shared/contracts.ts";
import { useHostRequestResponder } from "../host-request-response.ts";
import {
  createQuestionnaireDrafts,
  draftAnswer,
  type QuestionnaireDraft,
  questionnaireResult,
} from "./questionnaire-model.ts";

interface Props {
  request: HostRequest;
  projectId: string;
  threadId: string;
}

export function QuestionnaireRequest({ request, projectId, threadId }: Props) {
  const input = request.questionnaire;
  const [current, setCurrent] = useState(0);
  const [drafts, setDrafts] = useState<QuestionnaireDraft[]>(() => (input ? createQuestionnaireDrafts(input) : []));
  const { respond, responding, responseError } = useHostRequestResponder(projectId, threadId, request);
  const question = input?.questions[current];
  const draft = drafts[current];
  const answer = question && draft ? draftAnswer(question, current, draft) : undefined;
  const answered = drafts.filter((item, index) => {
    const itemQuestion = input?.questions[index];
    return itemQuestion && draftAnswer(itemQuestion, index, item);
  }).length;

  if (!input || !question || !draft) return null;

  const update = (patch: Partial<QuestionnaireDraft>) =>
    setDrafts((all) => all.map((item, index) => (index === current ? { ...item, ...patch } : item)));
  const toggle = (index: number) =>
    update({
      selected: question.multiSelect
        ? draft.selected.includes(index)
          ? draft.selected.filter((item) => item !== index)
          : [...draft.selected, index]
        : [index],
      custom: false,
      text: "",
      confirmed: question.multiSelect ?? false,
    });
  const confirmCurrentMulti = (items: QuestionnaireDraft[]) =>
    question.multiSelect && !draft.custom
      ? items.map((item, index) => (index === current ? { ...item, confirmed: true } : item))
      : items;
  const submit = (cancelled: boolean) => {
    const submittedDrafts = cancelled ? drafts : confirmCurrentMulti(drafts);
    const result = questionnaireResult(input, submittedDrafts, "", cancelled);
    void respond({ requestId: request.id, questionnaire: result });
  };
  const canCompleteCurrent = Boolean(answer) || (Boolean(question.multiSelect) && !draft.custom);
  const previousQuestionsAnswered = input.questions.every((itemQuestion, index) => {
    if (index === current) return true;
    const itemDraft = drafts[index];
    return itemDraft ? Boolean(draftAnswer(itemQuestion, index, itemDraft)) : false;
  });

  return (
    <section
      className="composer-surface flex w-full flex-col gap-2 rounded-(--composer-radius) border border-border/60 bg-(--composer-background) p-3 shadow-(--elevation-composer)"
      aria-label="扩展询问"
    >
      <div className="flex min-w-0 items-center justify-between gap-2 text-[11px] text-muted-foreground">
        {request.toolCallId ? (
          <span className="min-w-0 truncate font-mono" title={request.toolCallId}>
            工具 {request.toolCallId}
          </span>
        ) : (
          <span>扩展询问</span>
        )}
        <span className="shrink-0">
          {current + 1} / {input.questions.length} · 已完成 {answered}
        </span>
      </div>
      <div key={current} className="flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-medium text-muted-foreground">{question.header}</span>
          <h2 className="whitespace-pre-wrap break-words text-sm font-semibold">{question.question}</h2>
        </div>
        <div className="grid gap-1" role="group" aria-label={question.question}>
          {question.options.map((option, index) => {
            const selected = draft.selected.includes(index);
            return (
              <button
                autoFocus={index === 0}
                key={option.label}
                type="button"
                aria-pressed={selected}
                className={`rounded-lg border px-2.5 py-1.5 text-left text-xs ${selected ? "border-primary bg-accent" : "hover:bg-accent"}`}
                disabled={responding}
                onClick={() => toggle(index)}
              >
                {question.multiSelect ? (selected ? "☑ " : "☐ ") : ""}
                {option.label}
                <span className="ml-2 text-muted-foreground">{option.description}</span>
              </button>
            );
          })}
        </div>
      </div>
      {answer?.preview ? (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/30 p-2 text-[11px] leading-relaxed">
          {answer.preview}
        </pre>
      ) : null}
      <input
        aria-label="自定义回答"
        className="h-8 rounded-lg border bg-transparent px-2 text-xs"
        value={draft.text}
        disabled={responding}
        placeholder="Type something."
        onChange={(event) => {
          const text = event.target.value;
          update({ text, custom: Boolean(text), selected: [], confirmed: false });
        }}
      />
      <div className="flex justify-between gap-2">
        <Button variant="ghost" disabled={responding} onClick={() => submit(true)}>
          取消
        </Button>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={responding || current === 0}
            onClick={() => setCurrent((value) => value - 1)}
          >
            上一项
          </Button>
          {current < input.questions.length - 1 ? (
            <Button
              disabled={responding || !canCompleteCurrent}
              onClick={() => {
                setDrafts((items) => confirmCurrentMulti(items));
                setCurrent((value) => value + 1);
              }}
            >
              下一项
            </Button>
          ) : (
            <Button
              disabled={responding || !canCompleteCurrent || !previousQuestionsAnswered}
              onClick={() => submit(false)}
            >
              提交
            </Button>
          )}
        </div>
      </div>
      {responseError ? (
        <p className="text-xs text-destructive" role="alert">
          {responseError}
        </p>
      ) : null}
    </section>
  );
}
