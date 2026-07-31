import type { PiNoticeMessage } from "../../../../../../shared/contracts.ts";
import type { PiCheckpointFileDiff, PiCheckpointNoticeDetails } from "../../../../../../shared/pi-rewind-contracts.ts";
import { asRecord, notificationDetails, stringValue } from "../notification-data.ts";

export function parseCheckpointNotice(notice: PiNoticeMessage): PiCheckpointNoticeDetails | undefined {
  const details = asRecord(notificationDetails(notice));
  if (!details) return undefined;
  const checkpointId = stringValue(details, "checkpointId");
  const restoreCheckpointId = stringValue(details, "restoreCheckpointId");
  const reason = stringValue(details, "reason");
  const description = stringValue(details, "description");
  const fileCount = integerField(details, "fileCount");
  const additions = integerField(details, "additions");
  const deletions = integerField(details, "deletions");
  const truncated = details.truncated;
  if (
    !checkpointId ||
    !restoreCheckpointId ||
    (reason !== "run" && reason !== "recovery") ||
    description === undefined ||
    fileCount === undefined ||
    additions === undefined ||
    deletions === undefined ||
    typeof truncated !== "boolean" ||
    !Array.isArray(details.files)
  ) {
    return undefined;
  }
  const files = details.files.flatMap((value): PiCheckpointFileDiff[] => {
    const file = asRecord(value);
    if (!file) return [];
    const path = stringValue(file, "path");
    const fileAdditions = nullableIntegerField(file, "additions");
    const fileDeletions = nullableIntegerField(file, "deletions");
    if (!path || fileAdditions === undefined || fileDeletions === undefined) return [];
    return [{ path, additions: fileAdditions, deletions: fileDeletions }];
  });
  if (
    files.length !== details.files.length ||
    files.length > fileCount ||
    new Set(files.map((file) => file.path)).size !== files.length
  ) {
    return undefined;
  }
  return {
    checkpointId,
    restoreCheckpointId,
    reason,
    description,
    fileCount,
    additions,
    deletions,
    truncated,
    files,
  };
}

function integerField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function nullableIntegerField(record: Record<string, unknown>, key: string): number | null | undefined {
  return record[key] === null ? null : integerField(record, key);
}
