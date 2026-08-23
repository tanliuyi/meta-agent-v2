import type {
  StructuredWidgetDocument,
  StructuredWidgetNode,
  StructuredWidgetSource,
  StructuredWidgetState,
} from "./structured-widget.tsx";

const ASYNC_STATUS_WIDGET_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";
const ASYNC_STATUS_KIND = "pi-subagents.async-status-snapshot";
const ASYNC_STATUS_VERSION = 1;
const ASYNC_STATUS_MAX_CAPS: AsyncStatusSnapshotCaps = {
  maxRuns: 20,
  maxChildrenPerNode: 8,
  maxDepth: 3,
  maxStringLength: 160,
  maxSerializedBytes: 32 * 1024,
};

type AsyncStatusState = "queued" | "running" | "complete" | "failed" | "paused" | "stopped" | "rejected";
type AsyncStatusKind = "subagent" | "workflow" | "step";

interface AsyncStatusActivity {
  state?: string;
  currentTool?: string;
  lastActivityAt?: number;
  currentToolStartedAt?: number;
  turnCount?: number;
  toolCount?: number;
}

interface AsyncStatusNode {
  id: string;
  kind: AsyncStatusKind;
  label: string;
  state: AsyncStatusState;
  startedAt?: number;
  updatedAt?: number;
  endedAt?: number;
  activity?: AsyncStatusActivity;
  children?: AsyncStatusNode[];
}

interface AsyncStatusSnapshotCaps {
  maxRuns: number;
  maxChildrenPerNode: number;
  maxDepth: number;
  maxStringLength: number;
  maxSerializedBytes: number;
}

interface AsyncStatusSnapshot {
  kind: typeof ASYNC_STATUS_KIND;
  version: typeof ASYNC_STATUS_VERSION;
  generatedAt: number;
  caps: AsyncStatusSnapshotCaps;
  runs: AsyncStatusNode[];
  omitted: { runs: number; children: number; byteLimitExceeded: boolean };
}

/** 将插件公开的版本化状态 schema 投影为 Desktop 通用 structured widget 文档。 */
export function decodeAsyncStatusWidget(lines: readonly string[]): StructuredWidgetSource | undefined {
  const snapshot = parseAsyncStatusSnapshot(lines);
  if (!snapshot) return undefined;
  const counts = countStates(snapshot.runs);
  return {
    active: counts.running > 0 || counts.queued > 0,
    running: counts.running > 0,
    generatedAt: snapshot.generatedAt,
    project: (now) => projectAsyncStatus(snapshot, now),
  };
}

function parseAsyncStatusSnapshot(lines: readonly string[]): AsyncStatusSnapshot | undefined {
  if (lines.length !== 1 || !lines[0]?.startsWith(ASYNC_STATUS_WIDGET_PREFIX)) return undefined;
  try {
    const serialized = lines[0].slice(ASYNC_STATUS_WIDGET_PREFIX.length);
    if (serialized.length > ASYNC_STATUS_MAX_CAPS.maxSerializedBytes) return undefined;
    const serializedBytes = new TextEncoder().encode(serialized).byteLength;
    if (serializedBytes > ASYNC_STATUS_MAX_CAPS.maxSerializedBytes) return undefined;
    const value: unknown = JSON.parse(serialized);
    return isAsyncStatusSnapshot(value, serializedBytes) ? value : undefined;
  } catch {
    return undefined;
  }
}

function projectAsyncStatus(snapshot: AsyncStatusSnapshot, now: number): StructuredWidgetDocument {
  const counts = countStates(snapshot.runs);
  return {
    title: "Async agents",
    summary: headerSummary(counts, snapshot.runs.length),
    state: counts.running > 0 ? "running" : counts.queued > 0 ? "queued" : terminalSummaryState(counts),
    nodes: snapshot.runs.map((node) => projectNode(node, now)),
    omitted: omittedLabel(snapshot),
  };
}

function projectNode(node: AsyncStatusNode, now: number): StructuredWidgetNode {
  return {
    id: node.id,
    label: formatNodeLabel(node.label),
    status: node.state === "complete" ? "done" : node.state,
    state: presentationState(node.state),
    metadata: nodeMetadata(node, now),
    ...(node.children?.length ? { children: node.children.map((child) => projectNode(child, now)) } : {}),
  };
}

function presentationState(state: AsyncStatusState): StructuredWidgetState {
  if (state === "running") return "running";
  if (state === "queued") return "queued";
  if (state === "complete") return "success";
  if (state === "paused" || state === "stopped") return "warning";
  return "error";
}

function terminalSummaryState(counts: Record<AsyncStatusState, number>): StructuredWidgetState {
  if (counts.failed + counts.rejected > 0) return "error";
  if (counts.paused + counts.stopped > 0) return "warning";
  if (counts.complete > 0) return "success";
  return "neutral";
}

function nodeMetadata(node: AsyncStatusNode, now: number): string[] {
  const metadata: string[] = [];
  const children = node.children ?? [];
  const activity = aggregateActivity(node);
  if (children.length > 1) metadata.push(`steps ${children.length}`);
  if (node.startedAt !== undefined) metadata.push(formatDuration(Math.max(0, (node.endedAt ?? now) - node.startedAt)));
  const activityStatus = activityLabel(activity, now);
  if (activityStatus) metadata.push(activityStatus);
  if (activity.currentTool) {
    const toolDuration =
      activity.currentToolStartedAt === undefined
        ? undefined
        : formatDuration(Math.max(0, now - activity.currentToolStartedAt));
    metadata.push(`${activity.currentTool}${toolDuration ? ` ${toolDuration}` : ""}`);
  }
  if (activity.turnCount !== undefined) metadata.push(`${activity.turnCount} turns`);
  if (activity.toolCount !== undefined) metadata.push(`${activity.toolCount} tools`);
  return metadata;
}

function aggregateActivity(node: AsyncStatusNode): AsyncStatusActivity {
  const descendants = (node.children ?? []).map(aggregateActivity);
  const sum = (field: "turnCount" | "toolCount"): number | undefined => {
    const own = node.activity?.[field];
    if (own !== undefined && own > 0) return own;
    const values = descendants.flatMap((activity) => (activity[field] === undefined ? [] : [activity[field]]));
    return values.length > 0 ? values.reduce((total, value) => total + value, 0) : own;
  };
  const activityTimes = [
    node.activity?.lastActivityAt,
    ...descendants.map((activity) => activity.lastActivityAt),
  ].filter((value): value is number => value !== undefined);
  const turnCount = sum("turnCount");
  const toolCount = sum("toolCount");
  return {
    ...node.activity,
    ...(activityTimes.length > 0 ? { lastActivityAt: Math.max(...activityTimes) } : {}),
    ...(turnCount !== undefined ? { turnCount } : {}),
    ...(toolCount !== undefined ? { toolCount } : {}),
  };
}

function formatNodeLabel(label: string): string {
  const labels = label
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (labels.length > 1 && labels.every((item) => item === labels[0])) return `${labels[0]} ×${labels.length}`;
  return label;
}

function activityLabel(activity: AsyncStatusActivity, now: number): string | undefined {
  if (activity.lastActivityAt === undefined) {
    if (activity.state === "needs_attention") return "needs attention";
    if (activity.state === "active_long_running") return "active but long-running";
    return undefined;
  }
  const age = Math.max(0, now - activity.lastActivityAt);
  const ageLabel = age < 1_000 ? "now" : age < 60_000 ? `${Math.floor(age / 1_000)}s` : `${Math.floor(age / 60_000)}m`;
  if (activity.state === "needs_attention") return `no activity for ${ageLabel}`;
  if (activity.state === "active_long_running") {
    return `active but long-running · last activity ${ageLabel === "now" ? "now" : `${ageLabel} ago`}`;
  }
  return ageLabel === "now" ? "active now" : `active ${ageLabel} ago`;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest > 0 ? `${minutes}m${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}h${restMinutes}m` : `${hours}h`;
}

function countStates(nodes: readonly AsyncStatusNode[]): Record<AsyncStatusState, number> {
  const counts: Record<AsyncStatusState, number> = {
    queued: 0,
    running: 0,
    complete: 0,
    failed: 0,
    paused: 0,
    stopped: 0,
    rejected: 0,
  };
  for (const node of nodes) counts[node.state] += 1;
  return counts;
}

function headerSummary(counts: Record<AsyncStatusState, number>, total: number): string {
  const parts: string[] = [];
  if (counts.running > 0) parts.push(counts.running === 1 ? "1 agent running" : `${counts.running} agents running`);
  if (counts.queued > 0) parts.push(`${counts.queued} queued`);
  if (counts.running === 0 && counts.queued === 0) {
    const failed = counts.failed + counts.rejected;
    if (failed > 0) parts.push(`${failed} failed`);
    if (counts.stopped > 0) parts.push(`${counts.stopped} stopped`);
    if (counts.paused > 0) parts.push(`${counts.paused} paused`);
    if (counts.complete > 0) parts.push(`${counts.complete}/${total} done`);
  }
  return parts.join(", ") || `${total} total`;
}

function omittedLabel(snapshot: AsyncStatusSnapshot): string | undefined {
  const count = snapshot.omitted.runs + snapshot.omitted.children;
  if (count > 0) return `+${count} more${snapshot.omitted.byteLimitExceeded ? " · status truncated" : ""}`;
  return snapshot.omitted.byteLimitExceeded ? "status truncated" : undefined;
}

function isAsyncStatusSnapshot(value: unknown, serializedBytes: number): value is AsyncStatusSnapshot {
  if (
    !isRecord(value) ||
    value.kind !== ASYNC_STATUS_KIND ||
    value.version !== ASYNC_STATUS_VERSION ||
    !isSupportedCaps(value.caps)
  ) {
    return false;
  }
  const caps = value.caps;
  if (
    serializedBytes > caps.maxSerializedBytes ||
    !isTimestamp(value.generatedAt) ||
    !Array.isArray(value.runs) ||
    value.runs.length > caps.maxRuns ||
    !value.runs.every((node) => isAsyncStatusNode(node, caps, 0))
  ) {
    return false;
  }
  return (
    isRecord(value.omitted) &&
    isCount(value.omitted.runs) &&
    isCount(value.omitted.children) &&
    typeof value.omitted.byteLimitExceeded === "boolean"
  );
}

function isSupportedCaps(value: unknown): value is AsyncStatusSnapshotCaps {
  return (
    isCaps(value) &&
    value.maxRuns <= ASYNC_STATUS_MAX_CAPS.maxRuns &&
    value.maxChildrenPerNode <= ASYNC_STATUS_MAX_CAPS.maxChildrenPerNode &&
    value.maxDepth <= ASYNC_STATUS_MAX_CAPS.maxDepth &&
    value.maxStringLength <= ASYNC_STATUS_MAX_CAPS.maxStringLength &&
    value.maxSerializedBytes >= 256 &&
    value.maxSerializedBytes <= ASYNC_STATUS_MAX_CAPS.maxSerializedBytes
  );
}

function isCaps(value: unknown): value is AsyncStatusSnapshotCaps {
  return (
    isRecord(value) &&
    isCount(value.maxRuns) &&
    isCount(value.maxChildrenPerNode) &&
    isCount(value.maxDepth) &&
    isCount(value.maxStringLength) &&
    isCount(value.maxSerializedBytes)
  );
}

function isAsyncStatusNode(value: unknown, caps: AsyncStatusSnapshotCaps, depth: number): value is AsyncStatusNode {
  if (!isRecord(value) || depth > caps.maxDepth) return false;
  if (
    !isBoundedString(value.id, caps.maxStringLength) ||
    !isBoundedString(value.label, caps.maxStringLength) ||
    !isNodeKind(value.kind) ||
    !isNodeState(value.state)
  ) {
    return false;
  }
  if (value.startedAt !== undefined && !isTimestamp(value.startedAt)) return false;
  if (value.updatedAt !== undefined && !isTimestamp(value.updatedAt)) return false;
  if (value.endedAt !== undefined && !isTimestamp(value.endedAt)) return false;
  if (value.activity !== undefined && !isActivity(value.activity, caps.maxStringLength)) return false;
  return (
    value.children === undefined ||
    (Array.isArray(value.children) &&
      value.children.length <= caps.maxChildrenPerNode &&
      value.children.every((child) => isAsyncStatusNode(child, caps, depth + 1)))
  );
}

function isActivity(value: unknown, maxStringLength: number): value is AsyncStatusActivity {
  return (
    isRecord(value) &&
    (value.state === undefined || isBoundedString(value.state, maxStringLength)) &&
    (value.currentTool === undefined || isBoundedString(value.currentTool, maxStringLength)) &&
    (value.lastActivityAt === undefined || isTimestamp(value.lastActivityAt)) &&
    (value.currentToolStartedAt === undefined || isTimestamp(value.currentToolStartedAt)) &&
    (value.turnCount === undefined || isCount(value.turnCount)) &&
    (value.toolCount === undefined || isCount(value.toolCount))
  );
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCount(value: unknown): value is number {
  return isTimestamp(value);
}

function isNodeKind(value: unknown): value is AsyncStatusKind {
  return value === "subagent" || value === "workflow" || value === "step";
}

function isNodeState(value: unknown): value is AsyncStatusState {
  return (
    value === "queued" ||
    value === "running" ||
    value === "complete" ||
    value === "failed" ||
    value === "paused" ||
    value === "stopped" ||
    value === "rejected"
  );
}
