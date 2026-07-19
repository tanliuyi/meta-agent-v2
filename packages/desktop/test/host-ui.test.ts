import { describe, expect, it, vi } from "vitest";
import { HostUi } from "../src/main/pi/host-ui.ts";

describe("HostUi", () => {
  it("保留阻塞请求直到 renderer 响应", async () => {
    const changed = vi.fn();
    const host = new HostUi(changed, () => ["tool-1"]);
    const ui = host.createContext();
    const answer = ui.select("选择环境", ["dev", "prod"]);

    expect(host.requests).toMatchObject([
      { type: "select", title: "选择环境", options: ["dev", "prod"], toolCallId: "tool-1" },
    ]);
    host.respond({ requestId: host.requests[0]?.id ?? "", value: "prod" });

    await expect(answer).resolves.toBe("prod");
    expect(host.requests).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("支持 confirm、input 和 editor 的 Desktop 响应", async () => {
    const host = new HostUi(
      () => undefined,
      () => [],
    );
    const ui = host.createContext();

    const confirm = ui.confirm("执行", "是否继续");
    host.respond({ requestId: host.requests[0]?.id ?? "", confirmed: true });
    await expect(confirm).resolves.toBe(true);

    const input = ui.input("名称", "输入名称");
    host.respond({ requestId: host.requests[0]?.id ?? "", value: "alpha" });
    await expect(input).resolves.toBe("alpha");

    const editor = ui.editor("编辑", "原始内容");
    expect(host.requests[0]).toMatchObject({ type: "editor", message: "原始内容" });
    host.respond({ requestId: host.requests[0]?.id ?? "", value: "更新内容" });
    await expect(editor).resolves.toBe("更新内容");
  });

  it("将非阻塞扩展状态保存在当前 session", () => {
    const host = new HostUi(
      () => undefined,
      () => [],
    );
    const ui = host.createContext();

    ui.setStatus("lint", "运行中");
    ui.setWorkingMessage("正在检查");
    ui.setWorkingVisible(false);
    ui.setWidget("summary", ["A", "B"], { placement: "belowEditor" });
    ui.setEditorText("draft");
    ui.setToolsExpanded(true);

    expect(host.uiState).toMatchObject({
      statuses: { lint: "运行中" },
      workingMessage: "正在检查",
      workingVisible: false,
      editorText: "draft",
      editorRevision: 1,
      toolsExpanded: true,
      widgets: [{ key: "summary", lines: ["A", "B"], placement: "belowEditor" }],
    });

    host.syncEditorText("typed in Desktop");
    expect(ui.getEditorText()).toBe("typed in Desktop");
    expect(host.uiState.editorRevision).toBe(1);

    ui.pasteToEditor(" + extension");
    expect(host.uiState).toMatchObject({ editorText: "typed in Desktop + extension", editorRevision: 2 });
  });

  it("将通知直接发布到消息流，并将缺省类型归一化为 info", () => {
    const publishNotification = vi.fn();
    const host = new HostUi(
      () => undefined,
      () => [],
      publishNotification,
    );
    const ui = host.createContext();

    ui.notify("普通消息");
    ui.notify("需要注意", "warning");
    ui.notify("执行失败", "error");

    expect(publishNotification.mock.calls).toEqual([
      ["普通消息", "info"],
      ["需要注意", "warning"],
      ["执行失败", "error"],
    ]);
    expect(host.requests).toEqual([]);
  });

  it("静默忽略 Desktop 无法渲染的组件型 widget", () => {
    const changed = vi.fn();
    const host = new HostUi(changed, () => []);
    const ui = host.createContext();
    const setWidget = ui.setWidget as (key: string, content: unknown) => void;

    ui.setWidget("summary", ["保留现有内容"]);
    expect(() => setWidget("summary", () => undefined)).not.toThrow();

    expect(host.uiState.widgets).toEqual([{ key: "summary", lines: ["保留现有内容"], placement: "belowEditor" }]);
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
