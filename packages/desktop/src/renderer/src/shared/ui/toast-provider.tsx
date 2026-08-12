import * as ToastPrimitive from "@radix-ui/react-toast";
import { useCallback, useMemo, useState } from "react";
import { Toast } from "./toast.tsx";
import { ToastContext, type ToastNotification } from "./toast-context.ts";
import { ToastViewport } from "./toast-viewport.tsx";

interface ToastRecord extends ToastNotification {
  id: string;
}

export function ToastProvider({ children, ...props }: ToastPrimitive.ToastProviderProps) {
  const [notifications, setNotifications] = useState<ToastRecord[]>([]);
  const dismiss = useCallback((id: string) => {
    setNotifications((current) => current.filter((notification) => notification.id !== id));
  }, []);
  const notify = useCallback((notification: ToastNotification) => {
    const id = crypto.randomUUID();
    setNotifications((current) => [...current, { ...notification, id }]);
    return id;
  }, []);
  const update = useCallback((id: string, notification: ToastNotification) => {
    setNotifications((current) => current.map((item) => (item.id === id ? { ...notification, id } : item)));
  }, []);
  const value = useMemo(() => ({ notify, update, dismiss }), [dismiss, notify, update]);

  return (
    <ToastContext.Provider value={value}>
      <ToastPrimitive.Provider {...props}>
        {children}
        {notifications.map((notification) => (
          <Toast
            key={notification.id}
            open
            title={notification.title}
            message={notification.message}
            tone={notification.tone}
            duration={notification.duration}
            action={notification.action}
            onDismiss={() => dismiss(notification.id)}
          />
        ))}
        <ToastViewport />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}
