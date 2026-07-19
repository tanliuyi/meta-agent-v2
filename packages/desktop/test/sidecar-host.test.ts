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

  it("运行中的 prompt 立即接收 steer/follow-up，同时继续串行化其他变更命令", async () => {
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
    const second = schedule("setThinking", async () => {
      calls.push("set-thinking");
    });
    await steer;

    expect(calls).toEqual(["prompt-start", "steer"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(calls).toEqual(["prompt-start", "steer", "prompt-end", "set-thinking"]);
  });
});
