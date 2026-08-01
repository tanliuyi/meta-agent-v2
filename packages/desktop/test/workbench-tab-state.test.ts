import { describe, expect, it } from "vitest";
import {
  reduceWorkbenchTabState,
  reduceWorkbenchTabStates,
  WORKBENCH_TAB_INITIAL_STATE,
  type WorkbenchSessionTab,
} from "../src/renderer/src/state/workbench-tab-context.tsx";

function sessionTab(key: string, displayName = key, agentName?: string): WorkbenchSessionTab {
  return { kind: "session", key, projectId: "p", threadId: key, agentName, displayName };
}

describe("reduceWorkbenchTabState", () => {
  it("open-session-tab 注册 tab 并选中新 tab", () => {
    const state = reduceWorkbenchTabState(WORKBENCH_TAB_INITIAL_STATE, {
      type: "open-session-tab",
      tab: sessionTab("t1", "执行者", "worker"),
    });
    expect(state).toEqual({ tabs: [sessionTab("t1", "执行者", "worker")], activeKey: "t1" });
  });

  it("重复打开同一会话 tab 只做选中，不重复注册", () => {
    const first = reduceWorkbenchTabState(WORKBENCH_TAB_INITIAL_STATE, {
      type: "open-session-tab",
      tab: sessionTab("t1"),
    });
    const second = reduceWorkbenchTabState(first, { type: "open-session-tab", tab: sessionTab("t1") });
    expect(second).toBe(first);
    expect(second.tabs).toHaveLength(1);
    expect(second.activeKey).toBe("t1");
  });

  it("重复打开同一 Panel tab 只做选中，不重复注册", () => {
    const first = reduceWorkbenchTabState(WORKBENCH_TAB_INITIAL_STATE, {
      type: "open-panel-tab",
      panel: "files",
    });
    const second = reduceWorkbenchTabState(first, { type: "open-panel-tab", panel: "files" });
    expect(second).toBe(first);
    expect(second.tabs).toHaveLength(1);
    expect(second.activeKey).toBe("panel:files");
  });

  it("open-panel-tab 注册内置 Panel tab 并选中", () => {
    const state = reduceWorkbenchTabState(WORKBENCH_TAB_INITIAL_STATE, {
      type: "open-panel-tab",
      panel: "terminal",
    });
    expect(state.tabs).toEqual([{ kind: "panel", panel: "terminal" }]);
    expect(state.activeKey).toBe("panel:terminal");
  });

  it("重复打开同一 Panel tab 只做选中，不重复注册", () => {
    const first = reduceWorkbenchTabState(WORKBENCH_TAB_INITIAL_STATE, {
      type: "open-panel-tab",
      panel: "files",
    });
    const second = reduceWorkbenchTabState(first, { type: "open-panel-tab", panel: "files" });
    expect(second.tabs).toHaveLength(1);
    expect(second.activeKey).toBe("panel:files");
  });

  it("会话 tab 与 Panel tab 可混合注册", () => {
    let state = reduceWorkbenchTabState(WORKBENCH_TAB_INITIAL_STATE, {
      type: "open-panel-tab",
      panel: "tasks",
    });
    state = reduceWorkbenchTabState(state, { type: "open-session-tab", tab: sessionTab("t1") });
    expect(state.tabs).toEqual([{ kind: "panel", panel: "tasks" }, sessionTab("t1")]);
    expect(state.activeKey).toBe("t1");
  });

  it("close-tab 关闭活动 tab 后优先选中右侧相邻 tab", () => {
    let state = reduceWorkbenchTabState(WORKBENCH_TAB_INITIAL_STATE, {
      type: "open-panel-tab",
      panel: "files",
    });
    state = reduceWorkbenchTabState(state, { type: "open-panel-tab", panel: "terminal" });
    state = reduceWorkbenchTabState(state, { type: "open-panel-tab", panel: "tasks" });
    state = reduceWorkbenchTabState(state, { type: "close-tab", key: "panel:terminal" });
    expect(state.tabs.map((tab) => (tab.kind === "panel" ? `panel:${tab.panel}` : tab.key))).toEqual([
      "panel:files",
      "panel:tasks",
    ]);
    expect(state.activeKey).toBe("panel:tasks");
  });

  it("close-tab 关闭末尾活动 tab 后选中左侧相邻 tab", () => {
    let state = reduceWorkbenchTabState(WORKBENCH_TAB_INITIAL_STATE, {
      type: "open-panel-tab",
      panel: "files",
    });
    state = reduceWorkbenchTabState(state, { type: "open-panel-tab", panel: "terminal" });
    state = reduceWorkbenchTabState(state, { type: "close-tab", key: "panel:terminal" });
    expect(state.activeKey).toBe("panel:files");
  });

  it("close-tab 关闭非活动 tab 时保留当前选中", () => {
    let state = reduceWorkbenchTabState(WORKBENCH_TAB_INITIAL_STATE, {
      type: "open-panel-tab",
      panel: "files",
    });
    state = reduceWorkbenchTabState(state, { type: "open-session-tab", tab: sessionTab("t1") });
    state = reduceWorkbenchTabState(state, { type: "close-tab", key: "panel:files" });
    expect(state.tabs).toEqual([sessionTab("t1")]);
    expect(state.activeKey).toBe("t1");
  });

  it("close-tab 关闭最后一个 tab 后回到未选中状态", () => {
    const state = reduceWorkbenchTabState(WORKBENCH_TAB_INITIAL_STATE, {
      type: "open-panel-tab",
      panel: "tasks",
    });
    const closed = reduceWorkbenchTabState(state, { type: "close-tab", key: "panel:tasks" });
    expect(closed).toEqual(WORKBENCH_TAB_INITIAL_STATE);
  });

  it("activate 切换选中 tab，activate(null) 取消选中", () => {
    let state = reduceWorkbenchTabState(WORKBENCH_TAB_INITIAL_STATE, {
      type: "open-panel-tab",
      panel: "files",
    });
    state = reduceWorkbenchTabState(state, { type: "open-panel-tab", panel: "terminal" });
    const activated = reduceWorkbenchTabState(state, { type: "activate", key: "panel:files" });
    expect(activated.activeKey).toBe("panel:files");
    const deselected = reduceWorkbenchTabState(activated, { type: "activate", key: null });
    expect(deselected.activeKey).toBeNull();
    expect(deselected.tabs).toHaveLength(2);
  });

  it("open-new-panel 打开缺省页并取消 tab 选中", () => {
    let state = reduceWorkbenchTabState(WORKBENCH_TAB_INITIAL_STATE, {
      type: "open-panel-tab",
      panel: "files",
    });
    state = reduceWorkbenchTabState(state, { type: "open-new-panel" });
    expect(state.activeKey).toBeNull();
    expect(state.tabs).toHaveLength(1);
  });

  it("缺省页已展示时 open-new-panel 保持原状态", () => {
    const state = reduceWorkbenchTabState(WORKBENCH_TAB_INITIAL_STATE, { type: "open-new-panel" });
    expect(reduceWorkbenchTabState(state, { type: "open-new-panel" })).toBe(state);
  });

  it("open-panel-tab 以 draft kind 注册新会话草稿 tab", () => {
    let state = reduceWorkbenchTabState(WORKBENCH_TAB_INITIAL_STATE, { type: "open-new-panel" });
    state = reduceWorkbenchTabState(state, { type: "open-panel-tab", panel: "draft" });
    expect(state.tabs).toEqual([{ kind: "panel", panel: "draft" }]);
    expect(state.activeKey).toBe("panel:draft");
    state = reduceWorkbenchTabState(state, { type: "open-new-panel" });
    expect(state.activeKey).toBeNull();
    expect(state.tabs).toEqual([{ kind: "panel", panel: "draft" }]);
  });

  it("重复打开草稿面板只做选中，不重复注册", () => {
    let state = reduceWorkbenchTabState(WORKBENCH_TAB_INITIAL_STATE, { type: "open-panel-tab", panel: "draft" });
    state = reduceWorkbenchTabState(state, { type: "open-new-panel" });
    state = reduceWorkbenchTabState(state, { type: "open-panel-tab", panel: "draft" });
    expect(state.tabs.filter((tab) => tab.kind === "panel" && tab.panel === "draft")).toHaveLength(1);
    expect(state.activeKey).toBe("panel:draft");
  });

  it("close-tab 可关闭草稿面板 tab，关闭后回到缺省页", () => {
    let state = reduceWorkbenchTabState(WORKBENCH_TAB_INITIAL_STATE, { type: "open-panel-tab", panel: "draft" });
    state = reduceWorkbenchTabState(state, { type: "close-tab", key: "panel:draft" });
    expect(state).toEqual(WORKBENCH_TAB_INITIAL_STATE);
  });

  it("提交后草稿面板 tab 被会话 tab 替换", () => {
    let state = reduceWorkbenchTabState(WORKBENCH_TAB_INITIAL_STATE, { type: "open-panel-tab", panel: "draft" });
    state = reduceWorkbenchTabState(state, { type: "open-session-tab", tab: sessionTab("t1") });
    expect(state.activeKey).toBe("t1");
    state = reduceWorkbenchTabState(state, { type: "close-tab", key: "panel:draft" });
    expect(state.tabs).toEqual([sessionTab("t1")]);
    expect(state.activeKey).toBe("t1");
  });

  it("open-session-tab 与 activate 会退出新建缺省页", () => {
    let state = reduceWorkbenchTabState(WORKBENCH_TAB_INITIAL_STATE, { type: "open-new-panel" });
    state = reduceWorkbenchTabState(state, { type: "open-panel-tab", panel: "draft" });
    state = reduceWorkbenchTabState(state, { type: "open-session-tab", tab: sessionTab("t1") });
    expect(state.activeKey).toBe("t1");
    state = reduceWorkbenchTabState(state, { type: "open-new-panel" });
    state = reduceWorkbenchTabState(state, { type: "activate", key: null });
    expect(state.activeKey).toBeNull();
    expect(state.tabs).toHaveLength(2);
  });

  it("open-panel-tab 会退出新建缺省页", () => {
    let state = reduceWorkbenchTabState(WORKBENCH_TAB_INITIAL_STATE, { type: "open-new-panel" });
    state = reduceWorkbenchTabState(state, { type: "open-panel-tab", panel: "draft" });
    state = reduceWorkbenchTabState(state, { type: "open-panel-tab", panel: "terminal" });
    expect(state.activeKey).toBe("panel:terminal");
    expect(state.tabs.map((tab) => (tab.kind === "panel" ? `panel:${tab.panel}` : tab.key))).toEqual([
      "panel:draft",
      "panel:terminal",
    ]);
  });
});

describe("reduceWorkbenchTabStates", () => {
  it("不同主 session 的 tab 状态互相隔离", () => {
    let states = {};
    states = reduceWorkbenchTabStates(states, {
      type: "session",
      sessionKey: "s1",
      action: { type: "open-session-tab", tab: sessionTab("t1") },
    });
    states = reduceWorkbenchTabStates(states, {
      type: "session",
      sessionKey: "s2",
      action: { type: "open-panel-tab", panel: "terminal" },
    });
    expect(states.s1).toEqual({ tabs: [sessionTab("t1")], activeKey: "t1" });
    expect(states.s2).toEqual({ tabs: [{ kind: "panel", panel: "terminal" }], activeKey: "panel:terminal" });
    // s2 的操作不影响 s1
    states = reduceWorkbenchTabStates(states, {
      type: "session",
      sessionKey: "s2",
      action: { type: "open-new-panel" },
    });
    expect(states.s1?.activeKey).toBe("t1");
    expect(states.s2?.activeKey).toBeNull();
  });

  it("同一 session 内 tab 操作按 activeKey 隔离选中", () => {
    let states = {};
    states = reduceWorkbenchTabStates(states, {
      type: "session",
      sessionKey: "s1",
      action: { type: "open-panel-tab", panel: "files" },
    });
    states = reduceWorkbenchTabStates(states, {
      type: "session",
      sessionKey: "s1",
      action: { type: "open-panel-tab", panel: "tasks" },
    });
    expect(states.s1?.activeKey).toBe("panel:tasks");
  });

  it("prune 清理已 retire 的 session 状态并保留其余", () => {
    let states = {};
    states = reduceWorkbenchTabStates(states, {
      type: "session",
      sessionKey: "s1",
      action: { type: "open-panel-tab", panel: "files" },
    });
    states = reduceWorkbenchTabStates(states, {
      type: "session",
      sessionKey: "s2",
      action: { type: "open-panel-tab", panel: "tasks" },
    });
    states = reduceWorkbenchTabStates(states, { type: "prune", keep: new Set(["s1"]) });
    expect(Object.keys(states)).toEqual(["s1"]);
  });

  it("prune 无变化时保持原引用", () => {
    let states = {};
    states = reduceWorkbenchTabStates(states, {
      type: "session",
      sessionKey: "s1",
      action: { type: "open-panel-tab", panel: "files" },
    });
    const pruned = reduceWorkbenchTabStates(states, { type: "prune", keep: new Set(["s1"]) });
    expect(pruned).toBe(states);
  });
});
