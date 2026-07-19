import { createStore, type StoreApi } from "zustand/vanilla";
import { type DesktopAction, type DesktopState, desktopReducer, INITIAL_STATE } from "./desktop-model.ts";

export type DesktopStore = StoreApi<DesktopState>;

/** 创建窗口级 Desktop 状态容器；每个 renderer 窗口只能创建一个实例。 */
export function createDesktopStore(): DesktopStore {
  return createStore(() => INITIAL_STATE);
}

/** 通过唯一 reducer 提交 Desktop 状态转换，并保留未变化字段的引用。 */
export function dispatchDesktop(store: DesktopStore, action: DesktopAction): void {
  store.setState((state) => desktopReducer(state, action), true);
}
