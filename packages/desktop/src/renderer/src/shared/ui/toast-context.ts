import { createContext } from "react";
import type { ToastAction, ToastTone } from "./toast.tsx";

export interface ToastNotification {
  title?: string;
  message: string;
  tone?: ToastTone;
  duration?: number;
  action?: ToastAction;
}

export interface ToastContextValue {
  notify(notification: ToastNotification): string;
  update(id: string, notification: ToastNotification): void;
  dismiss(id: string): void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);
