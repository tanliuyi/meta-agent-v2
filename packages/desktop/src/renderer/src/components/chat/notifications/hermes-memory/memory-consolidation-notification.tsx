import type { PiNoticeMessage } from "../../../../../../shared/contracts.ts";
import { MemoryOperationNotification } from "./memory-operation-notification.tsx";

export function MemoryConsolidationNotification({ notice }: { notice: PiNoticeMessage }) {
  return <MemoryOperationNotification notice={notice} customType="hermes-memory.consolidation" />;
}
