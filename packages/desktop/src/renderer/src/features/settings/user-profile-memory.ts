import type { MemorySettingsSnapshot, MutateMemoryEntryInput } from "../../../../shared/memory-settings-contracts.ts";

export const USER_NAME_MEMORY_PREFIX = "用户名：";

export function createUserNameMemoryMutation(
  snapshot: MemorySettingsSnapshot,
  userName: string,
): MutateMemoryEntryInput {
  const content = `${USER_NAME_MEMORY_PREFIX}${userName}`;
  const existing = snapshot.collections
    .find(({ target }) => target === "user")
    ?.entries.find((entry) => entry.content.startsWith(USER_NAME_MEMORY_PREFIX));
  return existing
    ? {
        expectedRevision: snapshot.revision,
        action: "replace",
        target: "user",
        entryId: existing.id,
        content,
      }
    : { expectedRevision: snapshot.revision, action: "add", target: "user", content };
}
