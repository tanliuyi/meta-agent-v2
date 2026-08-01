import type { ComponentType, ReactNode } from "react";
import { useSyncExternalStore } from "react";

/**
 * workbench-panel 面板 tab 注册表（桌面系统基础架构）。
 *
 * 内置面板与扩展面板通过 registerWorkbenchPanelTab 注册定义（kind/label/icon/
 * 内容组件），workbench-panel 的 tab 条、新建缺省页与内容渲染全部经由注册表解析，
 * 新增面板无需改动核心组件，只需注册定义并调用 openPanelTab(kind)。
 */
export interface WorkbenchPanelTabDefinition {
  /** 面板注册键，即 panel tab 的 kind（如 "terminal"）；tab 定位键为 `panel:${kind}`。 */
  kind: string;
  /** Tab 展示名。 */
  label: string;
  /** Tab 图标。 */
  icon: ReactNode;
  /** 渲染面板内容的组件（在所在 session 的 workbench-panel 内挂载）。 */
  component: ComponentType;
  /** 是否在"新建 Panel"缺省页中提供手动添加入口；默认 true。 */
  addable?: boolean;
  /** 缺省页选项排序；数字越小越靠前。 */
  order?: number;
}

const definitions = new Map<string, WorkbenchPanelTabDefinition>();
const listeners = new Set<() => void>();
let snapshot: readonly WorkbenchPanelTabDefinition[] = [];
let snapshotDirty = false;

function notify(): void {
  snapshotDirty = true;
  for (const listener of listeners) listener();
}

function readSnapshot(): readonly WorkbenchPanelTabDefinition[] {
  if (snapshotDirty) {
    snapshot = [...definitions.values()].sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
    snapshotDirty = false;
  }
  return snapshot;
}

/** 注册一个面板 tab 定义并返回注销函数；同 kind 重复注册覆盖旧定义。 */
export function registerWorkbenchPanelTab(definition: WorkbenchPanelTabDefinition): () => void {
  definitions.set(definition.kind, definition);
  notify();
  return () => {
    if (definitions.get(definition.kind) !== definition) return;
    definitions.delete(definition.kind);
    notify();
  };
}

/** 按 kind 查询单个面板定义；未注册返回 undefined。 */
export function getWorkbenchPanelTabDefinition(kind: string): WorkbenchPanelTabDefinition | undefined {
  return definitions.get(kind);
}

/** 订阅面板注册表变化。 */
export function subscribeWorkbenchPanelTabs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 当前全部已注册的面板定义（按 order 升序）。 */
export function listWorkbenchPanelTabs(): readonly WorkbenchPanelTabDefinition[] {
  return readSnapshot();
}

/** 在组件中订阅面板注册表；运行期注册/注销会触发重渲染。 */
export function useWorkbenchPanelTabs(): readonly WorkbenchPanelTabDefinition[] {
  return useSyncExternalStore(subscribeWorkbenchPanelTabs, listWorkbenchPanelTabs, listWorkbenchPanelTabs);
}
