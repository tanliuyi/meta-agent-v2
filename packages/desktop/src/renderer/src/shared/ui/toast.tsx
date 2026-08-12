import * as ToastPrimitive from "@radix-ui/react-toast";
import X from "lucide-react/dist/esm/icons/x.mjs";

export type ToastTone = "info" | "success" | "warning" | "error";

export interface ToastAction {
  label: string;
  altText: string;
  onClick(): void;
}

const DEFAULT_TOAST_DURATION = 5000;

interface ToastProps {
  open: boolean;
  message: string;
  tone?: ToastTone;
  title?: string;
  duration?: number;
  action?: ToastAction;
  onDismiss(): void;
}

export function Toast({ open, message, tone = "info", title, duration, action, onDismiss }: ToastProps) {
  return (
    <ToastPrimitive.Root
      className="toast-root"
      data-tone={tone}
      open={open}
      duration={duration ?? DEFAULT_TOAST_DURATION}
      type={tone === "error" || tone === "warning" ? "foreground" : "background"}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onDismiss();
      }}
    >
      <div className="toast-content">
        {title ? <ToastPrimitive.Title className="toast-title">{title}</ToastPrimitive.Title> : null}
        <ToastPrimitive.Description className="toast-description">{message}</ToastPrimitive.Description>
      </div>
      {action ? (
        <ToastPrimitive.Action className="toast-action" altText={action.altText} onClick={action.onClick}>
          {action.label}
        </ToastPrimitive.Action>
      ) : null}
      <ToastPrimitive.Close className="toast-close" aria-label="关闭通知" title="关闭">
        <X aria-hidden="true" />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  );
}
