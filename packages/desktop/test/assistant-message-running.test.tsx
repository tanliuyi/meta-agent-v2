import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const messageState = vi.hoisted(() => ({
  threadRunning: true,
  isLast: true,
  status: "complete" as "complete" | "running",
  piStatus: "complete" as "complete" | "running",
  runActivityParticipated: false,
}));

vi.mock("@assistant-ui/react", () => ({
  MessagePrimitive: {
    Root: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  },
  useAuiState: (selector: (state: unknown) => unknown) =>
    selector({
      thread: { isRunning: messageState.threadRunning },
      message: {
        id: "assistant-1",
        isLast: messageState.isLast,
        status: { type: messageState.status },
        metadata: { custom: { pi: { status: { type: messageState.piStatus } } } },
      },
    }),
}));

vi.mock("../src/renderer/src/components/session-context.tsx", () => ({
  useSessionScope: () => ({
    record: {
      stores: {
        runActivity: {
          hasParticipated: () => messageState.runActivityParticipated,
          markParticipated: () => {
            messageState.runActivityParticipated = true;
          },
          reset: () => {
            messageState.runActivityParticipated = false;
          },
        },
      },
    },
  }),
}));

vi.mock("../src/renderer/src/components/chat/message/assistant-message-content.tsx", () => ({
  AssistantMessageContent: ({ isRunActivityRunning }: { isRunActivityRunning: boolean }) => (
    <div data-running={isRunActivityRunning} />
  ),
}));

vi.mock("../src/renderer/src/components/chat/message/assistant-message-action-bar.tsx", () => ({
  AssistantMessageActionBar: () => null,
}));

import {
  AssistantMessage,
  reduceRunActivityParticipation,
} from "../src/renderer/src/components/chat/message/assistant-message.tsx";

describe("AssistantMessage running state", () => {
  beforeEach(() => {
    messageState.threadRunning = true;
    messageState.isLast = true;
    messageState.status = "complete";
    messageState.piStatus = "complete";
    messageState.runActivityParticipated = false;
  });

  it("新 run 启动时不展开尚未参与本次运行的历史 assistant", () => {
    messageState.isLast = false;

    expect(renderToStaticMarkup(<AssistantMessage />)).toContain('data-running="false"');
  });

  it("新 prompt 启动时忽略 assistant-ui 对历史尾消息的瞬态 running facade", () => {
    messageState.status = "running";

    expect(renderToStaticMarkup(<AssistantMessage />)).toContain('data-running="false"');
  });

  it("切回 running session 时恢复已参与 run 的最后一条 assistant", () => {
    messageState.runActivityParticipated = true;

    expect(renderToStaticMarkup(<AssistantMessage />)).toContain('data-running="true"');
  });

  it("当前 Pi running assistant 立即展开", () => {
    messageState.status = "running";
    messageState.piStatus = "running";

    expect(renderToStaticMarkup(<AssistantMessage />)).toContain('data-running="true"');
  });

  it("只标记 thread 中最后一条 assistant", () => {
    messageState.status = "running";
    messageState.piStatus = "running";
    messageState.isLast = false;

    expect(renderToStaticMarkup(<AssistantMessage />)).toContain('data-running="false"');
  });

  it("thread 结束后收起最后一条 assistant", () => {
    messageState.status = "running";
    messageState.threadRunning = false;

    expect(renderToStaticMarkup(<AssistantMessage />)).toContain('data-running="false"');
  });

  it("assistant 参与当前 run 后，步骤间 complete 不清除 participation", () => {
    let participated = false;

    participated = reduceRunActivityParticipation(participated, true, true);
    expect(participated).toBe(true);

    participated = reduceRunActivityParticipation(participated, true, false);
    expect(participated).toBe(true);

    participated = reduceRunActivityParticipation(participated, false, false);
    expect(participated).toBe(false);
  });
});
