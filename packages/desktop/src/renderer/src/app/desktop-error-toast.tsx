import { ErrorToast } from "@renderer/shared/ui/error-toast";
import { useDesktopActions, useDesktopSelector } from "@renderer/state/desktop-context";

/** 将应用级 error selector 限定在通知节点，避免错误更新广播到工作台。 */
export function DesktopErrorToast() {
  const error = useDesktopSelector((state) => state.error);
  const { clearError } = useDesktopActions();
  return error ? <ErrorToast message={error} onDismiss={clearError} /> : null;
}
