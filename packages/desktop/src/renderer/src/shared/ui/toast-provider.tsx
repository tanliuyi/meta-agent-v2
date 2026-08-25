import * as ToastPrimitive from "@radix-ui/react-toast";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Toast } from "./toast.tsx";
import { ToastContext, type ToastNotification } from "./toast-context.ts";
import { ToastViewport } from "./toast-viewport.tsx";

interface ToastRecord extends ToastNotification {
  id: string;
  open: boolean;
}

const TOAST_EXIT_REMOVE_DELAY = 160;

export function ToastProvider({ children, ...props }: ToastPrimitive.ToastProviderProps) {
  const [notifications, setNotifications] = useState<ToastRecord[]>([]);
  const exitTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const remove = useCallback((id: string) => {
    setNotifications((current) => current.filter((notification) => notification.id !== id));
    exitTimers.current.delete(id);
  }, []);
  const dismiss = useCallback(
    (id: string) => {
      setNotifications((current) =>
        current.map((notification) => (notification.id === id ? { ...notification, open: false } : notification)),
      );
      if (exitTimers.current.has(id)) return;
      exitTimers.current.set(
        id,
        setTimeout(() => {
          remove(id);
        }, TOAST_EXIT_REMOVE_DELAY),
      );
    },
    [remove],
  );
  const notify = useCallback((notification: ToastNotification) => {
    const id = crypto.randomUUID();
    setNotifications((current) => [...current, { ...notification, id, open: true }]);
    return id;
  }, []);
  const update = useCallback((id: string, notification: ToastNotification) => {
    const exitTimer = exitTimers.current.get(id);
    if (exitTimer) {
      clearTimeout(exitTimer);
      exitTimers.current.delete(id);
    }
    setNotifications((current) => {
      const exists = current.some((item) => item.id === id);
      if (!exists) return [...current, { ...notification, id, open: true }];
      return current.map((item) => (item.id === id ? { ...notification, id, open: true } : item));
    });
  }, []);
  useEffect(
    () => () => {
      for (const timer of exitTimers.current.values()) clearTimeout(timer);
      exitTimers.current.clear();
    },
    [],
  );
  const value = useMemo(() => ({ notify, update, dismiss }), [dismiss, notify, update]);

  return (
    <ToastContext.Provider value={value}>
      <ToastPrimitive.Provider {...props}>
        {children}
        {notifications.map((notification) => (
          <Toast
            key={notification.id}
            open={notification.open}
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
