import type { PiNoticeMessage } from "../../../../../../shared/contracts.ts";
import { MemoryOperationNotification } from "./memory-operation-notification.tsx";

export function MemoryContextPreviewNotification({ notice }: { notice: PiNoticeMessage }) {
  return <MemoryOperationNotification notice={notice} customType="hermes-memory.context-preview" />;
}
