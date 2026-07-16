export interface ThreadMessageRow {
  id: string;
  role: "user" | "assistant" | "system";
}

export interface ThreadTurn {
  id: string;
  messageIds: readonly string[];
}

export interface ThreadTurnSections {
  leadingMessageIds: readonly string[];
  processMessageIds: readonly string[];
  answerMessageIds: readonly string[];
}

export interface ScrollerMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface ThreadScrollState {
  pinned: boolean;
  atBottom: boolean;
}

/** 保持仅内容更新时的行数组引用稳定。 */
export function projectThreadMessageRows(
  previous: readonly ThreadMessageRow[],
  messages: readonly ThreadMessageRow[],
): readonly ThreadMessageRow[] {
  if (
    previous.length === messages.length &&
    previous.every((row, index) => row.id === messages[index]?.id && row.role === messages[index]?.role)
  ) {
    return previous;
  }
  return messages.map(({ id, role }) => ({ id, role }));
}

/** 以 user message 为边界，把后续输出归入同一 turn。 */
export function buildThreadTurns(rows: readonly ThreadMessageRow[]): readonly ThreadTurn[] {
  const turns: { id: string; messageIds: string[] }[] = [];
  for (const { id, role } of rows) {
    const current = turns.at(-1);
    if (role === "user" || !current) {
      turns.push({ id, messageIds: [id] });
    } else {
      current.messageIds.push(id);
    }
  }
  return turns;
}

/** 将同一 turn 中最终 assistant 消息之前的输出归入统一过程区域。 */
export function partitionThreadTurn(
  turn: ThreadTurn,
  roleByMessageId: ReadonlyMap<string, ThreadMessageRow["role"]>,
): ThreadTurnSections {
  const firstAssistantIndex = turn.messageIds.findIndex((messageId) => roleByMessageId.get(messageId) === "assistant");
  if (firstAssistantIndex < 0) {
    return { leadingMessageIds: turn.messageIds, processMessageIds: [], answerMessageIds: [] };
  }
  const lastAssistantIndex = turn.messageIds.findLastIndex(
    (messageId) => roleByMessageId.get(messageId) === "assistant",
  );
  return {
    leadingMessageIds: turn.messageIds.slice(0, firstAssistantIndex),
    processMessageIds: turn.messageIds.slice(firstAssistantIndex, lastAssistantIndex),
    answerMessageIds: turn.messageIds.slice(lastAssistantIndex),
  };
}

/** snapshot 替换部分 message ID 时，通过仍稳定的成员复用既有 turn ID。 */
export function stabilizeThreadTurnIds(
  previous: readonly ThreadTurn[],
  current: readonly ThreadTurn[],
): readonly ThreadTurn[] {
  if (previous.length === 0 || current.length === 0) return current;

  const previousTurnIdByMessageId = new Map<string, string>();
  for (const turn of previous) {
    for (const messageId of turn.messageIds) previousTurnIdByMessageId.set(messageId, turn.id);
  }

  const reusedTurnIds = new Set<string>();
  let changed = false;
  const stabilized = current.map((turn) => {
    const previousTurnId = turn.messageIds
      .map((messageId) => previousTurnIdByMessageId.get(messageId))
      .find((turnId) => turnId !== undefined && !reusedTurnIds.has(turnId));
    const id = previousTurnId ?? turn.id;
    reusedTurnIds.add(id);
    if (id === turn.id) return turn;
    changed = true;
    return { ...turn, id };
  });

  return changed ? stabilized : current;
}

export function isScrollerAtBottom(metrics: ScrollerMetrics, threshold: number): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}

export function didUserScrollUp(previous: ScrollerMetrics, current: ScrollerMetrics): boolean {
  return (
    current.scrollTop < previous.scrollTop &&
    current.scrollHeight === previous.scrollHeight &&
    Math.abs(current.clientHeight - previous.clientHeight) <= 1
  );
}

/** 内容增长造成的瞬时离底不得解除 pinned，只有明确用户上滚才 detach。 */
export function resolveThreadScrollState({
  wasPinned,
  physicallyAtBottom,
  userScrolledUp,
}: {
  wasPinned: boolean;
  physicallyAtBottom: boolean;
  userScrolledUp: boolean;
}): ThreadScrollState {
  if (physicallyAtBottom) return { pinned: true, atBottom: true };
  if (userScrolledUp) return { pinned: false, atBottom: false };
  return { pinned: wasPinned, atBottom: wasPinned };
}
