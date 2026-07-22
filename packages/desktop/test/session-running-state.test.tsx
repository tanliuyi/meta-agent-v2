import type { AssistantRuntime } from "@assistant-ui/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createSessionRecord } from "../src/renderer/src/runtime/pi-session-store.ts";
import { SessionTransportManager } from "../src/renderer/src/runtime/session-transport-manager.ts";
import { usePiSessionRuntime } from "../src/renderer/src/runtime/use-pi-session-runtime.ts";
import { desktopReducer, INITIAL_STATE } from "../src/renderer/src/state/desktop-model.ts";
import type { SessionControlState, Thread } from "../src/shared/contracts.ts";
import { PROTOCOL_VERSION } from "../src/shared/contracts.ts";

describe("session route running state", () => {
  it("control running 在 timeline phase batch 到达前驱动 assistant-ui", () => {
    const record = createSessionRecord({ projectId: "p1", threadId: "t1" });
    record.stores.control.replace(control(true));
    record.stores.connection.setState("ready");
    let runtime: AssistantRuntime | undefined;

    function RuntimeProbe() {
      runtime = usePiSessionRuntime({
        record,
        active: true,
        transport: new SessionTransportManager(),
      }).runtime;
      return null;
    }

    renderToStaticMarkup(createElement(RuntimeProbe));

    expect(runtime?.thread.getState().isRunning).toBe(true);
  });

  it("cached control 通过窄 summary action 更新 catalog running", () => {
    const nextControl = control(true);
    const thread: Thread = {
      id: "t1",
      projectId: "p1",
      title: "旧标题",
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
      preview: "",
      archived: false,
      running: false,
    };
    let state = desktopReducer(INITIAL_STATE, {
      type: "project-threads-loaded",
      projectId: "p1",
      threads: [thread],
    });

    state = desktopReducer(state, {
      type: "thread-summary-updated",
      projectId: nextControl.projectId,
      threadId: nextControl.threadId,
      title: nextControl.title,
      updatedAt: nextControl.updatedAt,
      running: nextControl.running,
    });

    expect(state.threadCatalogs.p1?.[0]).toMatchObject({
      title: nextControl.title,
      updatedAt: nextControl.updatedAt,
      running: true,
    });
  });
});

function control(running: boolean): SessionControlState {
  return {
    protocolVersion: PROTOCOL_VERSION,
    revision: 2,
    projectId: "p1",
    threadId: "t1",
    title: "实时标题",
    updatedAt: 2,
    cwd: "C:/project",
    running,
    queueModes: { steering: "all", followUp: "all" },
    models: [],
    commands: [],
    thinkingLevel: "off",
    thinkingLevels: [],
    readiness: { state: "ready" },
    hostRequests: [],
    extensionUi: {
      statuses: {},
      widgets: [],
      workingVisible: false,
      editorRevision: 0,
      toolsExpanded: false,
    },
  };
}
