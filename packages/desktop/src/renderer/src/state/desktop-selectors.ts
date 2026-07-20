import type { SessionBootstrap, SessionControlState, Thread, WorkbenchState } from "../../../shared/contracts.ts";
import type { DesktopState } from "./desktop-model.ts";
import { desktopSessionKey } from "./desktop-model.ts";

const EMPTY_THREADS: Thread[] = [];
const EMPTY_PATHS: string[] = [];
const EMPTY_STATUSES: Readonly<Record<string, string>> = {};
const EMPTY_MODELS: SessionControlState["models"] = [];
const EMPTY_COMMANDS: SessionControlState["commands"] = [];
const EMPTY_THINKING_LEVELS: SessionControlState["thinkingLevels"] = [];
const EMPTY_WIDGETS: SessionControlState["extensionUi"]["widgets"] = [];

/** 选择稳定的 Project 列表引用。 */
export function selectProjects(state: DesktopState) {
  return state.projects;
}

/** 选择 active Project identity。 */
export function selectActiveProjectId(state: DesktopState): string | null {
  return state.project?.id ?? null;
}

/** 选择 active Project 名称。 */
export function selectActiveProjectName(state: DesktopState): string | null {
  return state.project?.name ?? null;
}

/** 选择 active Project 工作目录。 */
export function selectActiveProjectCwd(state: DesktopState): string | null {
  return state.project?.cwd ?? null;
}

/** 当前是否至少存在一个可用 Project。 */
export function selectHasAvailableProject(state: DesktopState): boolean {
  return state.projects.some(({ available }) => available);
}

/** 当前是否正在编辑或 materialize 新会话草稿。 */
export function selectHasDraft(state: DesktopState): boolean {
  return state.draft !== null;
}

/** 当前草稿是否正处于不可切换的 materialize 阶段。 */
export function selectIsDraftMaterializing(state: DesktopState): boolean {
  return state.draft?.phase === "materializing";
}

/** 选择指定 Project 的 thread catalog；尚未加载时返回 undefined。 */
export function selectProjectThreads(state: DesktopState, projectId: string): Thread[] | undefined {
  return state.threadCatalogs[projectId];
}

/** 选择当前 Project 的 active thread；draft 不属于持久化 thread。 */
export function selectActiveThreadId(state: DesktopState): string | null {
  if (state.draft || !state.project) return null;
  return state.activeThreadIds[state.project.id] ?? null;
}

/** 选择导航高亮 Project；pending 切换优先于已提交 Project。 */
export function selectNavigationProjectId(state: DesktopState): string | null {
  return state.pendingThreadLoad?.projectId ?? state.project?.id ?? null;
}

/** 选择导航高亮 thread；pending 切换优先于已提交 thread。 */
export function selectNavigationThreadId(state: DesktopState): string | null {
  if (state.pendingThreadLoad) return state.pendingThreadLoad.threadId;
  return selectActiveThreadId(state);
}

/** 仅在指定 Project 为当前导航目标时返回其 thread。 */
export function selectNavigationThreadIdForProject(state: DesktopState, projectId: string): string | null {
  return selectNavigationProjectId(state) === projectId ? selectNavigationThreadId(state) : null;
}

/** 返回当前 Project 的稳定 thread catalog；空值也保持引用稳定。 */
export function selectActiveThreads(state: DesktopState): Thread[] {
  return state.project ? (state.threadCatalogs[state.project.id] ?? EMPTY_THREADS) : EMPTY_THREADS;
}

/** 返回 active session 的状态缓存键；draft 或空工作区返回空字符串。 */
export function selectActiveSessionKey(state: DesktopState): string {
  const threadId = selectActiveThreadId(state);
  return state.project && threadId ? desktopSessionKey(state.project.id, threadId) : "";
}

/** 仅暴露与 active session identity 匹配的 bootstrap。 */
export function selectActiveBootstrap(state: DesktopState): SessionBootstrap | null {
  const key = selectActiveSessionKey(state);
  if (!key || !state.bootstrap) return null;
  return desktopSessionKey(state.bootstrap.projectId, state.bootstrap.threadId) === key ? state.bootstrap : null;
}

/** 选择 active session 的最新 control；新 control 优先于 bootstrap control。 */
export function selectActiveControl(state: DesktopState): SessionControlState | null {
  const key = selectActiveSessionKey(state);
  if (!key) return null;
  return state.controls[key] ?? selectActiveBootstrap(state)?.control ?? null;
}

/** 当前是否存在已 attach 的 active session control。 */
export function selectHasActiveControl(state: DesktopState): boolean {
  return selectActiveControl(state) !== null;
}

/** 选择 Composer 当前模型；无关 control 字段变化不影响引用。 */
export function selectActiveModel(state: DesktopState): SessionControlState["model"] {
  return selectActiveControl(state)?.model;
}

/** 选择 Composer 可用模型列表，并依赖 control merge 的稳定引用。 */
export function selectActiveModels(state: DesktopState): SessionControlState["models"] {
  return selectActiveControl(state)?.models ?? EMPTY_MODELS;
}

/** 选择 Composer slash command 列表。 */
export function selectActiveCommands(state: DesktopState): SessionControlState["commands"] {
  return selectActiveControl(state)?.commands ?? EMPTY_COMMANDS;
}

/** 选择 Composer 当前 thinking level。 */
export function selectActiveThinkingLevel(state: DesktopState): SessionControlState["thinkingLevel"] {
  return selectActiveControl(state)?.thinkingLevel ?? "off";
}

/** 选择 Composer 可用 thinking level 列表。 */
export function selectActiveThinkingLevels(state: DesktopState): SessionControlState["thinkingLevels"] {
  return selectActiveControl(state)?.thinkingLevels ?? EMPTY_THINKING_LEVELS;
}

/** 选择 Composer readiness 引用。 */
export function selectActiveReadiness(state: DesktopState): SessionControlState["readiness"] | null {
  return selectActiveControl(state)?.readiness ?? null;
}

/** 选择 Composer extension widgets 列表。 */
export function selectActiveExtensionWidgets(state: DesktopState): SessionControlState["extensionUi"]["widgets"] {
  return selectActiveControl(state)?.extensionUi.widgets ?? EMPTY_WIDGETS;
}

/** 选择 extension editor revision。 */
export function selectActiveEditorRevision(state: DesktopState): number {
  return selectActiveControl(state)?.extensionUi.editorRevision ?? 0;
}

/** 选择 extension editor text。 */
export function selectActiveEditorText(state: DesktopState): string | undefined {
  return selectActiveControl(state)?.extensionUi.editorText;
}

/** 选择当前首个 Host UI 请求，并复用 merge 后的 request identity。 */
export function selectActiveHostRequest(state: DesktopState): SessionControlState["hostRequests"][number] | null {
  return selectActiveControl(state)?.hostRequests[0] ?? null;
}

/** 选择 activity retry 状态。 */
export function selectActiveRetry(state: DesktopState): SessionControlState["retry"] {
  return selectActiveControl(state)?.retry;
}

/** 选择 activity working 可见性。 */
export function selectActiveWorkingVisible(state: DesktopState): boolean {
  return selectActiveControl(state)?.extensionUi.workingVisible ?? false;
}

/** 选择 activity working 文本。 */
export function selectActiveWorkingMessage(state: DesktopState): string | undefined {
  return selectActiveControl(state)?.extensionUi.workingMessage;
}

/** 选择 activity 最近错误。 */
export function selectActiveLastError(state: DesktopState): string | undefined {
  return selectActiveControl(state)?.lastError;
}

/** 选择任务面板需要的上下文占用百分比。 */
export function selectActiveContextPercent(state: DesktopState): number | null {
  return selectActiveControl(state)?.context?.percent ?? null;
}

/** 选择任务面板需要的扩展状态字典。 */
export function selectActiveExtensionStatuses(state: DesktopState): Readonly<Record<string, string>> {
  return selectActiveControl(state)?.extensionUi.statuses ?? EMPTY_STATUSES;
}

/** 选择 active session 的 Workbench 快照。 */
export function selectActiveWorkbench(state: DesktopState): WorkbenchState | null {
  const key = selectActiveSessionKey(state);
  return key ? (state.workbenches[key] ?? null) : null;
}

/** 选择当前 Workbench 激活的 Panel。 */
export function selectActivePanel(state: DesktopState): WorkbenchState["panel"] | null {
  return selectActiveWorkbench(state)?.panel ?? null;
}

/** 当前 Workbench 是否存在。 */
export function selectHasActiveWorkbench(state: DesktopState): boolean {
  return selectActiveWorkbench(state) !== null;
}

/** 当前右侧 Panel 是否打开。 */
export function selectActivePanelOpen(state: DesktopState): boolean {
  return selectActiveWorkbench(state)?.panelOpen ?? false;
}

/** 选择当前右侧 Panel 的持久化宽度。 */
export function selectActivePanelWidth(state: DesktopState): number | null {
  return selectActiveWorkbench(state)?.panelWidth ?? null;
}

/** 当前底部终端是否打开。 */
export function selectActiveTerminalOpen(state: DesktopState): boolean {
  return selectActiveWorkbench(state)?.terminalOpen ?? false;
}

/** 选择当前底部终端的持久化高度。 */
export function selectActiveTerminalHeight(state: DesktopState): number | null {
  return selectActiveWorkbench(state)?.terminalHeight ?? null;
}

/** 选择当前文件面板的 active file。 */
export function selectActiveFile(state: DesktopState): string | null {
  return selectActiveWorkbench(state)?.activeFile ?? null;
}

/** 选择当前文件面板的打开文件列表。 */
export function selectActiveOpenFiles(state: DesktopState): readonly string[] {
  return selectActiveWorkbench(state)?.openFiles ?? EMPTY_PATHS;
}

/** 选择当前文件面板的展开目录列表。 */
export function selectActiveExpandedPaths(state: DesktopState): readonly string[] {
  return selectActiveWorkbench(state)?.expandedPaths ?? EMPTY_PATHS;
}

/** 根据 draft/session readiness 派生 composer 的发送禁用状态。 */
export function selectIsSendDisabled(state: DesktopState): boolean {
  return state.draft
    ? state.draft.config?.readiness.state !== "ready"
    : selectActiveControl(state)?.readiness.state !== "ready";
}

/** 选择窗口标题 primitive，control 其他字段变化不会触发窗口框架更新。 */
export function selectWindowTitle(state: DesktopState): string {
  const control = selectActiveControl(state);
  return control?.extensionUi.windowTitle ?? control?.title ?? state.project?.name ?? "pi desktop";
}
