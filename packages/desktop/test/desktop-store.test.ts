import { describe, expect, it } from "vitest";
import {
  selectActiveCommands,
  selectActiveControl,
  selectActiveEditorRevision,
  selectActiveEditorText,
  selectActiveExtensionWidgets,
  selectActiveHostRequest,
  selectActiveLastError,
  selectActiveModel,
  selectActiveModels,
  selectActiveReadiness,
  selectActiveRetry,
  selectActiveSessionKey,
  selectActiveThinkingLevel,
  selectActiveThinkingLevels,
  selectActiveThreadId,
  selectActiveThreads,
  selectActiveWorkingMessage,
  selectActiveWorkingVisible,
  selectNavigationProjectId,
  selectNavigationThreadId,
} from "../src/renderer/src/state/desktop-selectors.ts";
import { createDesktopStore, dispatchDesktop } from "../src/renderer/src/state/desktop-store.ts";
import { PROTOCOL_VERSION, type Project, type SessionControlState, type Thread } from "../src/shared/contracts.ts";

const project: Project = {
  id: "project",
  name: "workspace",
  cwd: "/workspace",
  lastOpenedAt: 1,
  available: true,
};

const thread: Thread = {
  id: "thread",
  projectId: project.id,
  title: "会话",
  createdAt: 1,
  updatedAt: 1,
  messageCount: 0,
  preview: "",
  archived: false,
  running: false,
};

describe("desktop store selectors", () => {
  it("只从已提交的 active session 派生导航和缓存键", () => {
    const store = createDesktopStore();
    store.setState(
      (state) => ({
        ...state,
        projects: [project],
        project,
        threadCatalogs: { [project.id]: [thread] },
        activeThreadIds: { [project.id]: thread.id },
      }),
      true,
    );

    expect(selectActiveThreadId(store.getState())).toBe(thread.id);
    expect(selectNavigationProjectId(store.getState())).toBe(project.id);
    expect(selectNavigationThreadId(store.getState())).toBe(thread.id);
    expect(selectActiveSessionKey(store.getState())).toBe(`${project.id}:${thread.id}`);

    dispatchDesktop(store, { type: "draft-started", projectId: project.id });

    expect(selectActiveThreadId(store.getState())).toBeNull();
    expect(selectActiveSessionKey(store.getState())).toBe("");
  });

  it("无关 error 更新保留 Project 和 thread selector 引用", () => {
    const store = createDesktopStore();
    store.setState(
      (state) => ({
        ...state,
        projects: [project],
        project,
        threadCatalogs: { [project.id]: [thread] },
        activeThreadIds: { [project.id]: thread.id },
      }),
      true,
    );
    const projects = store.getState().projects;
    const threads = selectActiveThreads(store.getState());

    dispatchDesktop(store, { type: "error", error: "failed" });

    expect(store.getState().projects).toBe(projects);
    expect(selectActiveThreads(store.getState())).toBe(threads);
  });

  it("无关 control 字段更新不改变 Composer、Host 与 activity 叶子 selector", () => {
    const store = createDesktopStore();
    const control = sessionControl();
    store.setState(
      (state) => ({
        ...state,
        projects: [project],
        project,
        activeThreadIds: { [project.id]: thread.id },
        controls: { [`${project.id}:${thread.id}`]: control },
      }),
      true,
    );
    const previousControl = selectActiveControl(store.getState());
    const references = {
      model: selectActiveModel(store.getState()),
      models: selectActiveModels(store.getState()),
      commands: selectActiveCommands(store.getState()),
      thinkingLevels: selectActiveThinkingLevels(store.getState()),
      readiness: selectActiveReadiness(store.getState()),
      widgets: selectActiveExtensionWidgets(store.getState()),
      request: selectActiveHostRequest(store.getState()),
      retry: selectActiveRetry(store.getState()),
    };

    dispatchDesktop(store, {
      type: "control",
      control: structuredClone({
        ...control,
        revision: 2,
        context: { tokens: 20, contextWindow: 128_000, percent: 0.2 },
      }),
    });

    expect(selectActiveControl(store.getState())).not.toBe(previousControl);
    expect(selectActiveModel(store.getState())).toBe(references.model);
    expect(selectActiveModels(store.getState())).toBe(references.models);
    expect(selectActiveCommands(store.getState())).toBe(references.commands);
    expect(selectActiveThinkingLevel(store.getState())).toBe("medium");
    expect(selectActiveThinkingLevels(store.getState())).toBe(references.thinkingLevels);
    expect(selectActiveReadiness(store.getState())).toBe(references.readiness);
    expect(selectActiveExtensionWidgets(store.getState())).toBe(references.widgets);
    expect(selectActiveEditorRevision(store.getState())).toBe(1);
    expect(selectActiveEditorText(store.getState())).toBe("draft text");
    expect(selectActiveHostRequest(store.getState())).toBe(references.request);
    expect(selectActiveRetry(store.getState())).toBe(references.retry);
    expect(selectActiveWorkingVisible(store.getState())).toBe(true);
    expect(selectActiveWorkingMessage(store.getState())).toBe("working");
    expect(selectActiveLastError(store.getState())).toBe("last error");
  });
});

function sessionControl(): SessionControlState {
  return {
    protocolVersion: PROTOCOL_VERSION,
    revision: 1,
    projectId: project.id,
    threadId: thread.id,
    title: thread.title,
    updatedAt: 1,
    cwd: project.cwd,
    running: true,
    retry: { attempt: 1, maxAttempts: 3, message: "retrying" },
    queueModes: { steering: "all", followUp: "all" },
    model: { provider: "provider", id: "model", name: "Model" },
    models: [{ provider: "provider", id: "model", name: "Model", contextWindow: 128_000, thinking: true }],
    commands: [{ name: "help", source: "builtin" }],
    thinkingLevel: "medium",
    thinkingLevels: ["off", "medium"],
    context: { tokens: 10, contextWindow: 128_000, percent: 0.1 },
    readiness: { state: "ready" },
    lastError: "last error",
    hostRequests: [
      {
        id: "request",
        type: "confirm",
        title: "Confirm",
        workerInstanceId: "worker",
        createdAt: 1,
      },
    ],
    extensionUi: {
      statuses: {},
      workingMessage: "working",
      workingVisible: true,
      editorText: "draft text",
      editorRevision: 1,
      toolsExpanded: false,
      widgets: [{ key: "widget", lines: ["line"], placement: "aboveEditor" }],
    },
  };
}
