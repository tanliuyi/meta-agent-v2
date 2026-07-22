import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useDraftSession } from "../state/draft-session-context.tsx";
import { NewSessionSurface } from "./new-session-surface.tsx";

/** Mounts the route UI over the window-scoped draft runtime. */
export function NewSessionRoute() {
  const { runtime } = useDraftSession();
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <NewSessionSurface />
    </AssistantRuntimeProvider>
  );
}
