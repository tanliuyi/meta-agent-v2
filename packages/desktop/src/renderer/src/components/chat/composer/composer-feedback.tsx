import CircleAlert from "lucide-react/dist/esm/icons/circle-alert.mjs";
import Info from "lucide-react/dist/esm/icons/info.mjs";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert.mjs";
import type { ReactNode } from "react";

export type ComposerFeedbackTone = "info" | "warning" | "error";

interface ComposerFeedbackProps {
  tone: ComposerFeedbackTone;
  message: string;
  action?: ReactNode;
}

const FEEDBACK_ICONS = {
  info: Info,
  warning: TriangleAlert,
  error: CircleAlert,
} as const;

/** Composer 下方的状态反馈：只保留具体诊断文本，并用图标标识状态。 */
export function ComposerFeedback({ tone, message, action }: ComposerFeedbackProps) {
  const Icon = FEEDBACK_ICONS[tone];
  const isError = tone === "error";
  return (
    <div
      className="composer-feedback"
      data-tone={tone}
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      aria-atomic="true"
    >
      <span className="composer-feedback-icon" aria-hidden="true">
        <Icon />
      </span>
      <p className="composer-feedback-message">{message}</p>
      {action ? <span className="composer-feedback-action">{action}</span> : null}
    </div>
  );
}
