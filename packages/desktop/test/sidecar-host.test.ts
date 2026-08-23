import { describe, expect, it, vi } from "vitest";
import { createSidecarCommandScheduler } from "../src/sidecar/sidecar-host.ts";

describe("sidecar command scheduling", () => {
  it("serves bootstrap while a prompt is still running", async () => {
    const schedule = createSidecarCommandScheduler();
    let markPromptStarted!: () => void;
    let releasePrompt!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      markPromptStarted = resolve;
    });
    const promptBlocked = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const bootstrap = vi.fn();

    const prompt = schedule("prompt", async () => {
      markPromptStarted();
      await promptBlocked;
    });
    await promptStarted;
    await expect(
      schedule("bootstrap", async () => {
        bootstrap();
      }),
    ).resolves.toBeUndefined();

    expect(bootstrap).toHaveBeenCalledOnce();
    releasePrompt();
    await prompt;
  });

  it("运行中的 prompt 立即接收 steer/follow-up 和 thinking 变更", async () => {
    const schedule = createSidecarCommandScheduler();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: string[] = [];

    const first = schedule("prompt", async () => {
      calls.push("prompt-start");
      await firstBlocked;
      calls.push("prompt-end");
    });
    await vi.waitFor(() => expect(calls).toEqual(["prompt-start"]));
    const steer = schedule("prompt", async () => {
      calls.push("steer");
    });
    const setThinking = schedule("setThinking", async () => {
      calls.push("set-thinking");
    });
    await Promise.all([steer, setThinking]);

    expect(calls).toEqual(["prompt-start", "steer", "set-thinking"]);
    releaseFirst();
    await first;
    expect(calls).toEqual(["prompt-start", "steer", "set-thinking", "prompt-end"]);
  });

  it("模型与 thinking 变更可穿过 prompt，并按用户操作顺序串行", async () => {
    const schedule = createSidecarCommandScheduler();
    let releasePrompt!: () => void;
    let releaseModel!: () => void;
    const promptBlocked = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const modelBlocked = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const calls: string[] = [];

    const prompt = schedule("prompt", async () => {
      calls.push("prompt-start");
      await promptBlocked;
      calls.push("prompt-end");
    });
    await vi.waitFor(() => expect(calls).toEqual(["prompt-start"]));

    const setModel = schedule("setModel", async () => {
      calls.push("model-start");
      await modelBlocked;
      calls.push("model-end");
    });
    const setThinking = schedule("setThinking", async () => {
      calls.push("thinking");
    });
    await vi.waitFor(() => expect(calls).toEqual(["prompt-start", "model-start"]));
    expect(calls).not.toContain("thinking");

    releaseModel();
    await Promise.all([setModel, setThinking]);
    expect(calls).toEqual(["prompt-start", "model-start", "model-end", "thinking"]);

    releasePrompt();
    await prompt;
    expect(calls).toEqual(["prompt-start", "model-start", "model-end", "thinking", "prompt-end"]);
  });

  it("先发起的模型变更完成后才启动后续 prompt", async () => {
    const schedule = createSidecarCommandScheduler();
    let releaseModel!: () => void;
    const modelBlocked = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const calls: string[] = [];

    const setModel = schedule("setModel", async () => {
      calls.push("model-start");
      await modelBlocked;
      calls.push("model-end");
    });
    const prompt = schedule("prompt", async () => {
      calls.push("prompt");
    });

    await vi.waitFor(() => expect(calls).toEqual(["model-start"]));
    expect(calls).not.toContain("prompt");

    releaseModel();
    await Promise.all([setModel, prompt]);
    expect(calls).toEqual(["model-start", "model-end", "prompt"]);
  });

  it("等待模型 barrier 时原 prompt 结束后重新进入串行命令链", async () => {
    const schedule = createSidecarCommandScheduler();
    let releaseFirstPrompt!: () => void;
    let releaseModel!: () => void;
    let releaseCompact!: () => void;
    const firstPromptBlocked = new Promise<void>((resolve) => {
      releaseFirstPrompt = resolve;
    });
    const modelBlocked = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const compactBlocked = new Promise<void>((resolve) => {
      releaseCompact = resolve;
    });
    const calls: string[] = [];

    const firstPrompt = schedule("prompt", async () => {
      calls.push("first-prompt-start");
      await firstPromptBlocked;
      calls.push("first-prompt-end");
    });
    await vi.waitFor(() => expect(calls).toEqual(["first-prompt-start"]));

    const setModel = schedule("setModel", async () => {
      calls.push("model-start");
      await modelBlocked;
      calls.push("model-end");
    });
    const secondPrompt = schedule("prompt", async () => {
      calls.push("second-prompt");
    });
    const compact = schedule("compact", async () => {
      calls.push("compact-start");
      await compactBlocked;
      calls.push("compact-end");
    });

    releaseFirstPrompt();
    await firstPrompt;
    await vi.waitFor(() => expect(calls).toContain("compact-start"));
    releaseModel();
    await setModel;
    expect(calls).not.toContain("second-prompt");

    releaseCompact();
    await Promise.all([compact, secondPrompt]);
    expect(calls).toEqual([
      "first-prompt-start",
      "model-start",
      "first-prompt-end",
      "compact-start",
      "model-end",
      "compact-end",
      "second-prompt",
    ]);
  });

  it("prompt 运行期间 rename 立即执行，不等待 prompt 结束", async () => {
    const schedule = createSidecarCommandScheduler();
    let releasePrompt!: () => void;
    const promptBlocked = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const calls: string[] = [];

    const prompt = schedule("prompt", async () => {
      calls.push("prompt-start");
      await promptBlocked;
      calls.push("prompt-end");
    });
    await vi.waitFor(() => expect(calls).toEqual(["prompt-start"]));

    const rename = schedule("rename", async () => {
      calls.push("rename");
    });
    await rename;

    expect(calls).toEqual(["prompt-start", "rename"]);
    releasePrompt();
    await prompt;
    expect(calls).toEqual(["prompt-start", "rename", "prompt-end"]);
  });

  it("prompt 运行期间 getSummary 立即执行，不等待 prompt 结束", async () => {
    const schedule = createSidecarCommandScheduler();
    let releasePrompt!: () => void;
    const promptBlocked = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const calls: string[] = [];

    const prompt = schedule("prompt", async () => {
      calls.push("prompt-start");
      await promptBlocked;
      calls.push("prompt-end");
    });
    await vi.waitFor(() => expect(calls).toEqual(["prompt-start"]));

    const getSummary = schedule("getSummary", async () => {
      calls.push("getSummary");
    });
    await getSummary;

    expect(calls).toEqual(["prompt-start", "getSummary"]);
    releasePrompt();
    await prompt;
    expect(calls).toEqual(["prompt-start", "getSummary", "prompt-end"]);
  });

  it("prompt 运行期间图像资源读取立即执行", async () => {
    const schedule = createSidecarCommandScheduler();
    let releasePrompt!: () => void;
    const promptBlocked = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const calls: string[] = [];

    const prompt = schedule("prompt", async () => {
      calls.push("prompt-start");
      await promptBlocked;
      calls.push("prompt-end");
    });
    await vi.waitFor(() => expect(calls).toEqual(["prompt-start"]));

    await schedule("getImageResource", async () => {
      calls.push("image");
    });

    expect(calls).toEqual(["prompt-start", "image"]);
    releasePrompt();
    await prompt;
  });
});
