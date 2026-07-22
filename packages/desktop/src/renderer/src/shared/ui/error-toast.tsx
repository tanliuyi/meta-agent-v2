import X from "lucide-react/dist/esm/icons/x.mjs";

interface ErrorToastProps {
  message: string;
  onDismiss(): void;
}

/** 展示不属于具体 assistant message 的应用级错误。 */
export function ErrorToast({ message, onDismiss }: ErrorToastProps) {
  return (
    <div className="error-toast" role="alert">
      <pre>{message}</pre>
      <button type="button" onClick={onDismiss} aria-label="关闭">
        <X aria-hidden="true" />
      </button>
    </div>
  );
}
