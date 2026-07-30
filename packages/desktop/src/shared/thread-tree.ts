interface ThreadTreeEntry {
  id: string;
  parentThreadId?: string;
}

export function collectThreadDescendantIds(threads: readonly ThreadTreeEntry[], parentId: string): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const thread of threads) {
    if (!thread.parentThreadId) continue;
    const children = childrenByParent.get(thread.parentThreadId) ?? [];
    children.push(thread.id);
    childrenByParent.set(thread.parentThreadId, children);
  }
  const descendants: string[] = [];
  const pending = [...(childrenByParent.get(parentId) ?? [])];
  const visited = new Set([parentId]);
  for (let index = 0; index < pending.length; index += 1) {
    const id = pending[index];
    if (!id || visited.has(id)) continue;
    visited.add(id);
    descendants.push(id);
    pending.push(...(childrenByParent.get(id) ?? []));
  }
  return descendants;
}
