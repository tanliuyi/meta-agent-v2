import type { PiNoticeMessage } from "../../../../../../shared/contracts.ts";
import { MemoryOperationNotification } from "./memory-operation-notification.tsx";

export function MemoryGuideNotification({ notice }: { notice: PiNoticeMessage }) {
  return <MemoryOperationNotification notice={notice} customType="hermes-memory.guide" />;
}
