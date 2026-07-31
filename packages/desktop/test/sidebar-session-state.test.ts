import { describe, expect, it } from "vitest";
import {
  reduceSidebarSessionState,
  SIDEBAR_SESSION_INITIAL_STATE,
  type SidebarSessionTab,
} from "../src/renderer/src/state/sidebar-session-context.tsx";

function tab(key: string, displayName = key, agentName?: string): SidebarSessionTab {
  return { key, projectId: "p", threadId: key, agentName, displayName };
}

describe("reduceSidebarSessionState", () => {
  it("open-in-sidebar 注册 tab 并选中新 tab", () => {
    const state = reduceSidebarSessionState(SIDEBAR_SESSION_INITIAL_STATE, {
      type: "open-in-sidebar",
      tab: tab("t1", "执行者", "worker"),
    });
    expect(state).toEqual({ tabs: [tab("t1", "执行者", "worker")], activeKey: "t1", newPanel: "closed" });
  });

  it("重复打开同一 tab 只做选中，不重复注册", () => {
    const first = reduceSidebarSessionState(SIDEBAR_SESSION_INITIAL_STATE, {
      type: "open-in-sidebar",
      tab: tab("t1"),
    });
    const second = reduceSidebarSessionState(first, { type: "open-in-sidebar", tab: tab("t1") });
    expect(second.tabs).toHaveLength(1);
    expect(second.activeKey).toBe("t1");
  });

  it("普通会话 tab（无 agentName）同样可注册", () => {
    const state = reduceSidebarSessionState(SIDEBAR_SESSION_INITIAL_STATE, {
      type: "open-in-sidebar",
      tab: tab("t9", "重构侧边栏"),
    });
    expect(state.tabs[0]?.agentName).toBeUndefined();
    expect(state.activeKey).toBe("t9");
  });

  it("close-tab 关闭活动 tab 后优先选中右侧相邻 tab", () => {
    let state = reduceSidebarSessionState(SIDEBAR_SESSION_INITIAL_STATE, {
      type: "open-in-sidebar",
      tab: tab("t1"),
    });
    state = reduceSidebarSessionState(state, { type: "open-in-sidebar", tab: tab("t2") });
    state = reduceSidebarSessionState(state, { type: "open-in-sidebar", tab: tab("t3") });
    state = reduceSidebarSessionState(state, { type: "close-tab", key: "t2" });
    expect(state.tabs.map(({ key }) => key)).toEqual(["t1", "t3"]);
    expect(state.activeKey).toBe("t3");
  });

  it("close-tab 关闭末尾活动 tab 后选中左侧相邻 tab", () => {
    let state = reduceSidebarSessionState(SIDEBAR_SESSION_INITIAL_STATE, {
      type: "open-in-sidebar",
      tab: tab("t1"),
    });
    state = reduceSidebarSessionState(state, { type: "open-in-sidebar", tab: tab("t2") });
    state = reduceSidebarSessionState(state, { type: "close-tab", key: "t2" });
    expect(state.activeKey).toBe("t1");
  });

  it("close-tab 关闭非活动 tab 时保留当前选中", () => {
    let state = reduceSidebarSessionState(SIDEBAR_SESSION_INITIAL_STATE, {
      type: "open-in-sidebar",
      tab: tab("t1"),
    });
    state = reduceSidebarSessionState(state, { type: "open-in-sidebar", tab: tab("t2") });
    state = reduceSidebarSessionState(state, { type: "close-tab", key: "t1" });
    expect(state.tabs.map(({ key }) => key)).toEqual(["t2"]);
    expect(state.activeKey).toBe("t2");
  });

  it("close-tab 关闭最后一个 tab 后回到未选中状态", () => {
    const state = reduceSidebarSessionState(SIDEBAR_SESSION_INITIAL_STATE, {
      type: "open-in-sidebar",
      tab: tab("t1"),
    });
    const closed = reduceSidebarSessionState(state, { type: "close-tab", key: "t1" });
    expect(closed).toEqual(SIDEBAR_SESSION_INITIAL_STATE);
  });

  it("activate 切换选中 tab，activate(null) 取消选中", () => {
    let state = reduceSidebarSessionState(SIDEBAR_SESSION_INITIAL_STATE, {
      type: "open-in-sidebar",
      tab: tab("t1"),
    });
    state = reduceSidebarSessionState(state, { type: "open-in-sidebar", tab: tab("t2") });
    const activated = reduceSidebarSessionState(state, { type: "activate", key: "t1" });
    expect(activated.activeKey).toBe("t1");
    const deselected = reduceSidebarSessionState(activated, { type: "activate", key: null });
    expect(deselected.activeKey).toBeNull();
    expect(deselected.tabs).toHaveLength(2);
  });

  it("open-new-panel 打开缺省页并取消会话 tab 选中", () => {
    let state = reduceSidebarSessionState(SIDEBAR_SESSION_INITIAL_STATE, {
      type: "open-in-sidebar",
      tab: tab("t1"),
    });
    state = reduceSidebarSessionState(state, { type: "open-new-panel" });
    expect(state.newPanel).toBe("default");
    expect(state.activeKey).toBeNull();
  });

  it("start-new-draft 进入草稿，再点新建 Panel 回到缺省页", () => {
    let state = reduceSidebarSessionState(SIDEBAR_SESSION_INITIAL_STATE, { type: "open-new-panel" });
    state = reduceSidebarSessionState(state, { type: "start-new-draft" });
    expect(state.newPanel).toBe("draft");
    state = reduceSidebarSessionState(state, { type: "open-new-panel" });
    expect(state.newPanel).toBe("default");
    expect(state.activeKey).toBeNull();
  });

  it("open-in-sidebar 与 activate 会关闭新建 Panel", () => {
    let state = reduceSidebarSessionState(SIDEBAR_SESSION_INITIAL_STATE, { type: "open-new-panel" });
    state = reduceSidebarSessionState(state, { type: "start-new-draft" });
    state = reduceSidebarSessionState(state, { type: "open-in-sidebar", tab: tab("t1") });
    expect(state.newPanel).toBe("closed");
    expect(state.activeKey).toBe("t1");
    state = reduceSidebarSessionState(state, { type: "open-new-panel" });
    state = reduceSidebarSessionState(state, { type: "activate", key: null });
    expect(state.newPanel).toBe("closed");
  });
});
