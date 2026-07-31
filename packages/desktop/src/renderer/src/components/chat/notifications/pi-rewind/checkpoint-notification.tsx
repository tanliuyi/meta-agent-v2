import {
  useSessionControlSelector,
  useSessionScope,
  useSessionTimelineSelector,
} from "@renderer/components/session-context";
import { useCallback } from "react";
import type { PiNoticeMessage } from "../../../../../../shared/contracts.ts";
import type { PiCheckpointNoticeDetails } from "../../../../../../shared/pi-rewind-contracts.ts";
import { type CheckpointDiffLoader, CheckpointNotificationView } from "./checkpoint-notification-view.tsx";

export function CheckpointNotification({ notice }: { notice: PiNoticeMessage }) {
  const { projectId, threadId } = useSessionScope().record.identity;
  const canRestore = useSessionControlSelector((control) => control !== null && control.interaction !== "read-only");
  const idle = useSessionTimelineSelector((timeline) => timeline.phase === "idle");
  const loadDiff = useCallback<CheckpointDiffLoader>(
    (details, path) =>
      window.desktop.sessions.getCheckpointDiff({
        projectId,
        threadId,
        fromCheckpointId: details.restoreCheckpointId,
        toCheckpointId: details.checkpointId,
        path,
      }),
    [projectId, threadId],
  );
  const restore = useCallback(
    (details: PiCheckpointNoticeDetails) =>
      window.desktop.sessions.restoreCheckpoint({
        projectId,
        threadId,
        checkpointId: details.restoreCheckpointId,
        expectedCheckpointId: details.checkpointId,
      }),
    [projectId, threadId],
  );
  return (
    <CheckpointNotificationView
      notice={notice}
      canRestore={canRestore && idle}
      loadDiff={loadDiff}
      onRestore={restore}
    />
  );
}
