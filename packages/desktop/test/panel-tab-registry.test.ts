import { describe, expect, it } from "vitest";
import {
  NEW_SESSION_PANEL_KIND,
  registerBuiltinPanelTabs,
} from "../src/renderer/src/components/panel/builtin-panel-tabs.tsx";
import {
  getWorkbenchPanelTabDefinition,
  listWorkbenchPanelTabs,
  registerWorkbenchPanelTab,
  subscribeWorkbenchPanelTabs,
} from "../src/renderer/src/state/panel-tab-registry.ts";

describe("panel-tab-registry", () => {
  it("注册后可按 kind 查询并按 order 排序", () => {
    const unregisterB = registerWorkbenchPanelTab({
      kind: "b",
      label: "B",
      icon: null,
      component: () => null,
      order: 2,
    });
    const unregisterA = registerWorkbenchPanelTab({
      kind: "a",
      label: "A",
      icon: null,
      component: () => null,
      order: 1,
    });
    try {
      expect(getWorkbenchPanelTabDefinition("a")?.label).toBe("A");
      expect(listWorkbenchPanelTabs().map((definition) => definition.kind)).toEqual(["a", "b"]);
    } finally {
      unregisterA();
      unregisterB();
    }
  });

  it("同 kind 重复注册覆盖，旧注销不影响新定义", () => {
    const unregisterOld = registerWorkbenchPanelTab({ kind: "x", label: "旧", icon: null, component: () => null });
    const unregisterNew = registerWorkbenchPanelTab({ kind: "x", label: "新", icon: null, component: () => null });
    try {
      expect(getWorkbenchPanelTabDefinition("x")?.label).toBe("新");
      unregisterOld();
      expect(getWorkbenchPanelTabDefinition("x")?.label).toBe("新");
    } finally {
      unregisterNew();
    }
  });

  it("订阅注册表变化", () => {
    const counts: number[] = [];
    const unsubscribe = subscribeWorkbenchPanelTabs(() => counts.push(listWorkbenchPanelTabs().length));
    const unregister = registerWorkbenchPanelTab({ kind: "y", label: "Y", icon: null, component: () => null });
    unsubscribe();
    unregister();
    expect(counts).toEqual([1]);
  });

  it("registerBuiltinPanelTabs 注册全部内置面板且幂等", () => {
    registerBuiltinPanelTabs();
    registerBuiltinPanelTabs();
    expect(listWorkbenchPanelTabs().map((definition) => definition.kind)).toEqual([
      NEW_SESSION_PANEL_KIND,
      "terminal",
      "files",
      "tasks",
    ]);
    expect(getWorkbenchPanelTabDefinition(NEW_SESSION_PANEL_KIND)?.label).toBe("新会话");
    expect(getWorkbenchPanelTabDefinition("terminal")?.label).toBe("终端");
    expect(getWorkbenchPanelTabDefinition("files")?.label).toBe("资源管理");
    expect(getWorkbenchPanelTabDefinition("tasks")?.label).toBe("侧边任务");
    for (const definition of listWorkbenchPanelTabs()) {
      expect(definition.addable).not.toBe(false);
    }
  });
});
