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

  it("subagent run 期间 cancel 和 steer 立即执行", async () => {
    const schedule = createSidecarCommandScheduler();
    let releaseRun!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const calls: string[] = [];
    const run = schedule("subagentRun", async () => {
      calls.push("run-start");
      await blocked;
      calls.push("run-end");
    });
    await vi.waitFor(() => expect(calls).toEqual(["run-start"]));

    await Promise.all([
      schedule("subagentCancel", async () => {
        calls.push("cancel");
      }),
      schedule("subagentSteer", async () => {
        calls.push("steer");
      }),
    ]);
    expect(calls).toEqual(["run-start", "cancel", "steer"]);
    releaseRun();
    await run;
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
});
