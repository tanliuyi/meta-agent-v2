interface ErrorToastProps {
  message: string;
  onDismiss(): void;
}

/** 展示不属于具体 assistant message 的应用级错误。 */
export function ErrorToast({ message, onDismiss }: ErrorToastProps) {
  return (
    <div className="error-toast" role="alert">
      <pre>{message}</pre>
      <button type="button" onClick={onDismiss}>
        关闭
      </button>
    </div>
  );
}
