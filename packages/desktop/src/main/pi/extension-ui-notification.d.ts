import "@earendil-works/pi-coding-agent";

declare module "@earendil-works/pi-coding-agent" {
  interface ExtensionUINotificationOptions {
    customType: string;
    details?: unknown;
  }

  interface ExtensionUIContext {
    notify(message: string, type?: "info" | "warning" | "error", options?: ExtensionUINotificationOptions): void;
  }
}
