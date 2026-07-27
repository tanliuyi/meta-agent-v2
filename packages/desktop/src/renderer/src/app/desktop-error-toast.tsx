import { Toast } from "@renderer/shared/ui/toast";
import { useDesktopActions, useDesktopSelector } from "@renderer/state/desktop-context";

/** 将应用级 error selector 限定在通知节点，避免错误更新广播到工作台。 */
export function DesktopErrorToast() {
  const error = useDesktopSelector((state) => state.error);
  const { clearError } = useDesktopActions();
  return error ? <Toast open message={error} tone="error" title="操作失败" onDismiss={clearError} /> : null;
}
