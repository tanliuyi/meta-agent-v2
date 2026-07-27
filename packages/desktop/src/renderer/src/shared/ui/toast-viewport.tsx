import * as ToastPrimitive from "@radix-ui/react-toast";

export function ToastViewport() {
  return <ToastPrimitive.Viewport className="toast-viewport" label="通知 ({hotkey})" />;
}
