import { useEffect, useSyncExternalStore } from "react";
import type { CachedSessionRecord } from "../runtime/pi-session-store.ts";
import { type DesktopStore, dispatchDesktop } from "./desktop-store.ts";

interface SessionCatalogControlBridgeProps {
  record: CachedSessionRecord;
  store: DesktopStore;
}

/** Mirrors cached session control state into the window-level thread catalog. */
export function SessionCatalogControlBridge({ record, store }: SessionCatalogControlBridgeProps) {
  const control = useSyncExternalStore(
    record.stores.control.subscribe,
    record.stores.control.getSnapshot,
    record.stores.control.getSnapshot,
  );

  useEffect(() => {
    if (!control) return;
    dispatchDesktop(store, {
      type: "thread-summary-updated",
      projectId: control.projectId,
      threadId: control.threadId,
      title: control.title,
      updatedAt: control.updatedAt,
      running: control.running,
    });
  }, [control, store]);

  return null;
}
