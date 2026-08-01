import type { Attachment } from "@assistant-ui/react";
import { describe, expect, it } from "vitest";
import { ensureDraftCreateRequestId } from "../src/renderer/src/state/draft-creation.ts";
import { SessionDraft } from "../src/renderer/src/state/session-draft-context.tsx";
import type { DraftSessionConfig } from "../src/shared/contracts.ts";

const imageAttachment: Attachment = {
  id: "a1",
  type: "image",
  name: "a.png",
  status: { type: "complete" },
  content: [],
};

const configA: DraftSessionConfig = {
  models: [
    {
      provider: "openai",
      id: "gpt",
      name: "GPT",
      contextWindow: 128_000,
      thinking: true,
      thinkingLevels: ["off", "high"],
    },
  ],
  commands: [],
  model: { provider: "openai", id: "gpt", name: "GPT" },
  thinkingLevel: "off",
  thinkingLevels: ["off", "high"],
  readiness: { state: "ready" },
};

const configB: DraftSessionConfig = {
  models: [
    {
      provider: "anthropic",
      id: "opus",
      name: "Opus",
      contextWindow: 200_000,
      thinking: true,
      thinkingLevels: ["off", "high"],
    },
  ],
  commands: [],
  model: { provider: "anthropic", id: "opus", name: "Opus" },
  thinkingLevel: "off",
  thinkingLevels: ["off", "high"],
  readiness: { state: "ready" },
};

/**
 * 行为边界回归：两个主 session 的草稿上下文必须完全隔离。
 * 每个 SessionDraft 即应用实际使用的按主 session 草稿容器
 * （composer 文本/附件经 SessionDraftHost 双向同步到独立 runtime）。
 */
describe("workbench new-session draft isolation per main session", () => {
  it("A 的 composer 文本/附件不会泄漏到 B 的草稿", () => {
    const draftA = new SessionDraft("p\u0000session-a", { projectId: "p", threadId: "session-a" });
    const draftB = new SessionDraft("p\u0000session-b", { projectId: "p", threadId: "session-b" });

    draftA.setComposer("A 的提示词", [imageAttachment]);

    expect(draftA.composer.text).toBe("A 的提示词");
    expect(draftA.composer.attachments).toHaveLength(1);
    // B 的草稿不受 A 影响：文本与附件均保持初始空状态。
    expect(draftB.composer.text).toBe("");
    expect(draftB.composer.attachments).toHaveLength(0);
  });

  it("A 的模型配置不会泄漏到 B 的草稿", () => {
    const draftA = new SessionDraft("p\u0000session-a", { projectId: "p", threadId: "session-a" });
    const draftB = new SessionDraft("p\u0000session-b", { projectId: "p", threadId: "session-b" });

    draftA.setConfig(configA);
    expect(draftA.config?.model.provider).toBe("openai");
    expect(draftB.config).toBeNull();
    expect(draftB.phase).toBe("loading");

    draftB.setConfig(configB);
    expect(draftB.config?.model.provider).toBe("anthropic");
    // A 的配置不被 B 覆盖。
    expect(draftA.config?.model.provider).toBe("openai");
  });

  it("提交状态与 createRequestIds 按主 session 隔离：A 的 in-flight 提交不阻塞 B，也不会复用 A 的 requestId", () => {
    const draftA = new SessionDraft("p\u0000session-a", { projectId: "p", threadId: "session-a" });
    const draftB = new SessionDraft("p\u0000session-b", { projectId: "p", threadId: "session-b" });

    draftA.setSubmitInFlight(true);
    expect(draftA.submitInFlight).toBe(true);
    expect(draftB.submitInFlight).toBe(false);

    // 同一项目下 A、B 各自持有独立 requestId：B 的 create 不会复用 A 的请求。
    const requestIdA = ensureDraftCreateRequestId(draftA.createRequestIds, "p");
    const requestIdB = ensureDraftCreateRequestId(draftB.createRequestIds, "p");
    expect(requestIdB).not.toBe(requestIdA);
  });

  it("A 提交成功后的清理不影响 B 的草稿", () => {
    const draftA = new SessionDraft("p\u0000session-a", { projectId: "p", threadId: "session-a" });
    const draftB = new SessionDraft("p\u0000session-b", { projectId: "p", threadId: "session-b" });
    draftA.setComposer("A 的提示词", []);
    draftA.setConfig(configA);
    draftA.setSubmitInFlight(true);
    draftB.setComposer("B 的提示词", []);
    draftB.setConfig(configB);

    draftA.clear();

    expect(draftA.composer.text).toBe("");
    expect(draftA.config).toBeNull();
    expect(draftA.submitInFlight).toBe(false);
    expect(draftB.composer.text).toBe("B 的提示词");
    expect(draftB.config?.model.provider).toBe("anthropic");
    expect(draftB.submitInFlight).toBe(false);
  });

  it("每个草稿绑定的父会话为创建时的主 session：A 的提示词不可能在 B 的父会话下提交", () => {
    const draftA = new SessionDraft("p\u0000session-a", { projectId: "p", threadId: "session-a" });
    const draftB = new SessionDraft("p\u0000session-b", { projectId: "p", threadId: "session-b" });

    expect(draftA.parent).toEqual({ projectId: "p", threadId: "session-a" });
    expect(draftB.parent).toEqual({ projectId: "p", threadId: "session-b" });
    expect(draftA.parent.threadId).not.toBe(draftB.parent.threadId);
  });
});
