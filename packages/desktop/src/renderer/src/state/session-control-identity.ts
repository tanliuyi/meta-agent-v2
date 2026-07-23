import type {
  DesktopExtensionHostState,
  HostRequest,
  ModelOption,
  SessionControlState,
  SlashCommand,
} from "../../../shared/contracts.ts";

/**
 * 合并 structured-clone 后的 control，并复用语义未变化的嵌套引用。
 *
 * Electron IPC 会复制数组和对象；若直接写入 reducer，原子 selector 会把等值数据误判为变化。
 */
export function mergeSessionControl(
  previous: SessionControlState | undefined,
  incoming: SessionControlState,
): SessionControlState {
  if (!previous) return incoming;
  return {
    ...incoming,
    ...(equalOptionalRecord(previous.retry, incoming.retry) ? { retry: previous.retry } : {}),
    queueModes: equalRecord(previous.queueModes, incoming.queueModes) ? previous.queueModes : incoming.queueModes,
    ...(equalOptionalRecord(previous.model, incoming.model) ? { model: previous.model } : {}),
    models: reuseArray(previous.models, incoming.models, equalModel),
    commands: reuseArray(previous.commands, incoming.commands, equalCommand),
    thinkingLevels: reuseArray(previous.thinkingLevels, incoming.thinkingLevels, Object.is),
    ...(equalOptionalRecord(previous.context, incoming.context) ? { context: previous.context } : {}),
    readiness: equalRecord(previous.readiness, incoming.readiness) ? previous.readiness : incoming.readiness,
    hostRequests: reuseArray(previous.hostRequests, incoming.hostRequests, equalHostRequest),
    extensionSet:
      previous.extensionSet.generation === incoming.extensionSet.generation &&
      previous.extensionSet.reloadRequired === incoming.extensionSet.reloadRequired &&
      equalArray(previous.extensionSet.diagnostics, incoming.extensionSet.diagnostics, equalRecord)
        ? previous.extensionSet
        : incoming.extensionSet,
    extensionHost: mergeExtensionHost(previous.extensionHost, incoming.extensionHost),
  };
}

function mergeExtensionHost(
  previous: DesktopExtensionHostState,
  incoming: DesktopExtensionHostState,
): DesktopExtensionHostState {
  const statuses = equalRecord(previous.statuses, incoming.statuses) ? previous.statuses : incoming.statuses;
  const widgets = reuseArray(
    previous.widgets,
    incoming.widgets,
    (left, right) =>
      left.key === right.key && left.placement === right.placement && equalArray(left.lines, right.lines, Object.is),
  );
  if (
    statuses === previous.statuses &&
    widgets === previous.widgets &&
    previous.windowTitle === incoming.windowTitle &&
    equalOptionalRecord(previous.composerCommand, incoming.composerCommand)
  )
    return previous;
  return { ...incoming, statuses, widgets };
}

function equalModel(left: ModelOption, right: ModelOption): boolean {
  return (
    left.provider === right.provider &&
    left.id === right.id &&
    left.name === right.name &&
    left.contextWindow === right.contextWindow &&
    left.thinking === right.thinking
  );
}

function equalCommand(left: SlashCommand, right: SlashCommand): boolean {
  return left.name === right.name && left.description === right.description && left.source === right.source;
}

function equalHostRequest(left: HostRequest, right: HostRequest): boolean {
  return (
    left.id === right.id &&
    left.type === right.type &&
    left.title === right.title &&
    left.message === right.message &&
    left.placeholder === right.placeholder &&
    equalOptionalArray(left.options, right.options, Object.is) &&
    left.toolCallId === right.toolCallId &&
    left.workerInstanceId === right.workerInstanceId &&
    left.createdAt === right.createdAt
  );
}

function reuseArray<T>(previous: T[], incoming: T[], equal: (left: T, right: T) => boolean): T[] {
  return equalArray(previous, incoming, equal) ? previous : incoming;
}

function equalOptionalArray<T>(
  left: T[] | undefined,
  right: T[] | undefined,
  equal: (left: T, right: T) => boolean,
): boolean {
  if (!left || !right) return left === right;
  return equalArray(left, right, equal);
}

function equalArray<T>(left: readonly T[], right: readonly T[], equal: (left: T, right: T) => boolean): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => right[index] !== undefined && equal(value, right[index]))
  );
}

function equalOptionalRecord<T extends object>(left: T | undefined, right: T | undefined): boolean {
  if (!left || !right) return left === right;
  return equalRecord(left, right);
}

function equalRecord<T extends object>(left: T, right: T): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([key, value]) => Object.hasOwn(right, key) && Object.is(value, right[key as keyof T]))
  );
}
