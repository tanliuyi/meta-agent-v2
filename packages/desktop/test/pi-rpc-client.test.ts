import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiThreadStore } from "../src/renderer/src/runtime/pi-thread-store.ts";
import type { SessionBootstrap, SessionPushPayload } from "../src/shared/contracts.ts";
import { PiRpcClient } from "../src/sidecar/pi-rpc-client.ts";
import { PiRpcSessionRuntime, summarize } from "../src/sidecar/pi-rpc-session-runtime.ts";
import { loadSystemPiDraftConfig } from "../src/sidecar/system-pi-draft-config.ts";
import { type ProbedSystemPi, resolveSystemPi } from "../src/sidecar/system-pi-resolver.ts";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-pi-rpc.mjs", import.meta.url));
const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function fakePi(): ProbedSystemPi {
  return {
    command: process.execPath,
    argsPrefix: [fixturePath],
    executablePath: fixturePath,
    version: "0.84.2",
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("resolveSystemPi", () => {
  it("resolves a POSIX executable from an absolute PATH entry", () => {
    const root = temporaryDirectory("desktop-pi-posix-");
    const executable = join(root, "pi");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);

    const canonicalExecutable = realpathSync(executable);
    expect(resolveSystemPi({ PATH: `${delimiter}${root}` }, "linux")).toEqual({
      command: canonicalExecutable,
      argsPrefix: [],
      executablePath: canonicalExecutable,
    });
  });

  it("resolves a validated Windows npm shim to node.exe and the package CLI", () => {
    const root = temporaryDirectory("desktop-pi-win-");
    const packageRoot = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
    const cliPath = join(packageRoot, "dist", "cli.js");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(join(root, "pi.cmd"), "@echo off\n");
    writeFileSync(join(root, "node.exe"), "node\n");
    writeFileSync(cliPath, "console.log('fake');\n");
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.83.0", bin: { pi: "dist/cli.js" } }),
    );

    const canonicalRoot = realpathSync(root);
    expect(resolveSystemPi({ Path: root }, "win32")).toEqual({
      command: join(canonicalRoot, "node.exe"),
      argsPrefix: [join(canonicalRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js")],
      executablePath: join(canonicalRoot, "pi.cmd"),
      packageRoot: join(canonicalRoot, "node_modules", "@earendil-works", "pi-coding-agent"),
    });
  });

  it("resolves a Windows npm shim using node.exe from PATH", () => {
    const root = temporaryDirectory("desktop-pi-win-prefix-");
    const nodeRoot = temporaryDirectory("desktop-node-win-");
    const packageRoot = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
    const cliPath = join(packageRoot, "dist", "cli.js");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(join(root, "pi.cmd"), "@echo off\n");
    writeFileSync(join(nodeRoot, "node.exe"), "node\n");
    writeFileSync(cliPath, "console.log('fake');\n");
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.83.0", bin: { pi: "dist/cli.js" } }),
    );

    const canonicalRoot = realpathSync(root);
    const canonicalNodeRoot = realpathSync(nodeRoot);
    expect(resolveSystemPi({ PATH: `${root}${delimiter}${nodeRoot}` }, "win32")).toMatchObject({
      command: join(canonicalNodeRoot, "node.exe"),
      argsPrefix: [join(canonicalRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js")],
      executablePath: join(canonicalRoot, "pi.cmd"),
      packageRoot: join(canonicalRoot, "node_modules", "@earendil-works", "pi-coding-agent"),
    });
  });

  it("does not resolve relative or empty PATH entries", () => {
    expect(() => resolveSystemPi({ PATH: `${delimiter}.` }, "linux")).toThrow(
      "Unable to find a runnable system Pi CLI in PATH",
    );
  });
});

describe("PiRpcSessionRuntime", () => {
  it("rejects system Pi versions older than the 0.84.2 wire protocol", async () => {
    await expect(
      PiRpcSessionRuntime.create({
        binding: {
          mode: "create",
          projectId: "project-1",
          cwd: temporaryDirectory("desktop-pi-cwd-"),
          agentDir: temporaryDirectory("desktop-pi-user-data-"),
          sessionId: "session-old-pi",
          createInput: {
            projectId: "project-1",
            createRequestId: "create-old-pi",
            model: { provider: "configured-provider", id: "configured-model" },
            thinkingLevel: "low",
          },
        },
        push: () => undefined,
        onSummaryChanged: () => undefined,
        resolvePi: async () => ({ ...fakePi(), version: "0.84.1" }),
      }),
    ).rejects.toThrow("install 0.84.2 or newer");
  });

  it("creates a system Pi session and projects a completed prompt", async () => {
    const userData = temporaryDirectory("desktop-pi-user-data-");
    const cwd = temporaryDirectory("desktop-pi-cwd-");
    const pushes: SessionPushPayload[] = [];
    const runtime = await PiRpcSessionRuntime.create({
      binding: {
        mode: "create",
        projectId: "project-1",
        cwd,
        agentDir: userData,
        sessionId: "session-1",
        createInput: {
          projectId: "project-1",
          createRequestId: "create-1",
          model: { provider: "configured-provider", id: "configured-model" },
          thinkingLevel: "low",
        },
      },
      push: (payload) => pushes.push(payload),
      onSummaryChanged: () => undefined,
      resolvePi: async () => fakePi(),
    });

    try {
      expect(runtime.sessionFile).toBe(join(userData, "session-1.jsonl"));
      expect(runtime.bootstrap()).toMatchObject({
        projectId: "project-1",
        threadId: "session-1",
        timeline: { nodes: [], phase: "idle" },
        control: {
          model: { provider: "configured-provider", id: "configured-model" },
          thinkingLevel: "low",
          context: { tokens: 0, contextWindow: 100000, percent: 0 },
          commands: [
            {
              name: "reload",
              description: "Reload System Pi extensions, skills, prompts, and context files",
              source: "builtin",
              acceptsArguments: false,
            },
            {
              name: "extension-command",
              description: "Extension command",
              source: "extension",
            },
          ],
        },
      });

      await expect(
        runtime.prompt({
          requestId: "prompt-1",
          projectId: "project-1",
          threadId: "session-1",
          text: "hello",
          images: [],
        }),
      ).resolves.toEqual({ accepted: true, queued: false });

      await vi.waitFor(() => {
        expect(runtime.bootstrap().timeline.nodes).toHaveLength(2);
        expect(runtime.bootstrap().timeline.phase).toBe("idle");
      });
      expect(runtime.bootstrap().timeline.nodes).toMatchObject([
        { kind: "user", content: [{ type: "text", text: "hello" }] },
        { kind: "assistant", content: [{ type: "text", text: "reply:hello" }] },
      ]);
      expect(runtime.bootstrap().control.context).toEqual({ tokens: 2, contextWindow: 100000, percent: 0.002 });
      const timelinePushes = pushes.filter(
        (payload): payload is Extract<SessionPushPayload, { type: "timeline" }> => payload.type === "timeline",
      );
      const promptEventIndex = timelinePushes.findIndex(({ event }) => event.type === "agent_start");
      const promptEvents = timelinePushes.slice(promptEventIndex);
      expect(promptEventIndex).toBeGreaterThanOrEqual(0);
      expect(promptEvents.map(({ sequence }) => sequence)).toEqual(
        Array.from({ length: 10 }, (_, index) => promptEvents[0]!.sequence + index),
      );
      expect(promptEvents.map(({ event }) => event.type)).toEqual([
        "agent_start",
        "message_start",
        "message_end",
        "message_start",
        "message_update",
        "message_update",
        "message_update",
        "message_update",
        "message_end",
        "agent_settled",
      ]);
      expect(
        promptEvents.flatMap(({ event }) =>
          event.type === "message_update" && event.assistantMessageEvent.type === "text_delta"
            ? [event.assistantMessageEvent.delta]
            : [],
        ),
      ).toEqual(["reply:", "hello"]);
      expect(runtime.threadSummary(false)).toMatchObject({ title: "hello", messageCount: 2, running: false });
      const timeline = runtime.bootstrap().timeline;
      const lastCreatedAt = timeline.nodes.at(-1)?.createdAt;
      if (lastCreatedAt === undefined) throw new Error("Expected a projected assistant message");
      expect(summarize("session-1", undefined, timeline, lastCreatedAt - 1).updatedAt).toBe(lastCreatedAt);
      expect(summarize("session-1", undefined, timeline, lastCreatedAt + 1).updatedAt).toBe(lastCreatedAt + 1);

      await runtime.compact();
      await vi.waitFor(() => expect(runtime.bootstrap().timeline.phase).toBe("idle"));
    } finally {
      await runtime.dispose();
    }
  });

  it("uses Pi's effective thinking level after the requested level is clamped", async () => {
    const runtime = await PiRpcSessionRuntime.create({
      binding: {
        mode: "create",
        projectId: "project-1",
        cwd: temporaryDirectory("desktop-pi-cwd-"),
        agentDir: temporaryDirectory("desktop-pi-user-data-"),
        sessionId: "session-thinking-clamp",
        createInput: {
          projectId: "project-1",
          createRequestId: "create-thinking-clamp",
          model: { provider: "configured-provider", id: "configured-model" },
          thinkingLevel: "low",
        },
      },
      push: () => undefined,
      onSummaryChanged: () => undefined,
      resolvePi: async () => fakePi(),
    });

    try {
      await runtime.setThinking("max");
      expect(runtime.bootstrap().control.thinkingLevel).toBe("high");
      expect(runtime.bootstrap().events).toContainEqual({
        sequence: expect.any(Number),
        event: { type: "thinking_level_changed", level: "high" },
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("switches model and thinking during streaming without changing the in-flight response", async () => {
    const runtime = await PiRpcSessionRuntime.create({
      binding: {
        mode: "create",
        projectId: "project-1",
        cwd: temporaryDirectory("desktop-pi-cwd-"),
        agentDir: temporaryDirectory("desktop-pi-user-data-"),
        sessionId: "session-runtime-model-switch",
        createInput: {
          projectId: "project-1",
          createRequestId: "create-runtime-model-switch",
          model: { provider: "fake-provider", id: "fake-model" },
          thinkingLevel: "low",
        },
      },
      push: () => undefined,
      onSummaryChanged: () => undefined,
      resolvePi: async () => fakePi(),
    });

    try {
      await runtime.prompt({
        requestId: "runtime-model-switch",
        projectId: "project-1",
        threadId: "session-runtime-model-switch",
        text: "__stream_pause__",
        images: [],
      });
      await vi.waitFor(() => expect(runtime.bootstrap().timeline.phase).toBe("running"));

      await runtime.setModel("custom-provider", "custom-reasoning-model");
      await runtime.setThinking("max");
      expect(runtime.bootstrap().control).toMatchObject({
        model: { provider: "custom-provider", id: "custom-reasoning-model" },
        thinkingLevel: "max",
        thinkingLevels: ["off", "high", "max"],
        context: { tokens: 0, contextWindow: 200000, percent: 0 },
      });

      await vi.waitFor(() => expect(runtime.bootstrap().timeline.phase).toBe("idle"));
      expect(runtime.bootstrap().timeline.nodes.at(-1)).toMatchObject({
        kind: "assistant",
        provenance: { provider: "fake-provider", model: "fake-model", thinkingLevel: "low" },
      });

      await runtime.prompt({
        requestId: "after-runtime-model-switch",
        projectId: "project-1",
        threadId: "session-runtime-model-switch",
        text: "after switch",
        images: [],
      });
      await vi.waitFor(() => expect(runtime.bootstrap().timeline.nodes).toHaveLength(4));
      expect(runtime.bootstrap().timeline.nodes.at(-1)).toMatchObject({
        kind: "assistant",
        provenance: { provider: "custom-provider", model: "custom-reasoning-model", thinkingLevel: "max" },
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("projects summarization retry phases and retry control", async () => {
    const pushes: SessionPushPayload[] = [];
    const runtime = await PiRpcSessionRuntime.create({
      binding: {
        mode: "create",
        projectId: "project-1",
        cwd: temporaryDirectory("desktop-pi-cwd-"),
        agentDir: temporaryDirectory("desktop-pi-user-data-"),
        sessionId: "session-summarization-retry",
        createInput: {
          projectId: "project-1",
          createRequestId: "create-summarization-retry",
          model: { provider: "configured-provider", id: "configured-model" },
          thinkingLevel: "low",
        },
      },
      push: (payload) => pushes.push(payload),
      onSummaryChanged: () => undefined,
      resolvePi: async () => fakePi(),
    });

    try {
      await runtime.prompt({
        requestId: "summarization-retry",
        projectId: "project-1",
        threadId: "session-summarization-retry",
        text: "__summarization_retry__",
        images: [],
      });
      await vi.waitFor(() => {
        expect(runtime.bootstrap()).toMatchObject({
          timeline: { phase: "retrying" },
          control: { retry: { attempt: 1, maxAttempts: 3, message: "overloaded" } },
        });
      });
      await vi.waitFor(() => expect(runtime.bootstrap().timeline.phase).toBe("compacting"));
      await vi.waitFor(() => {
        expect(runtime.bootstrap().timeline.phase).toBe("idle");
        expect(runtime.bootstrap().control.retry).toBeUndefined();
      });
      expect(
        pushes.flatMap((payload) =>
          payload.type === "timeline" && payload.event.type.startsWith("summarization_retry_")
            ? [payload.event.type]
            : [],
        ),
      ).toEqual(["summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished"]);
    } finally {
      await runtime.dispose();
    }
  });

  it("bootstrap replays the raw Pi events emitted after its stable persisted snapshot", async () => {
    const runtime = await PiRpcSessionRuntime.create({
      binding: {
        mode: "create",
        projectId: "project-1",
        cwd: temporaryDirectory("desktop-pi-cwd-"),
        agentDir: temporaryDirectory("desktop-pi-user-data-"),
        sessionId: "session-stream-replay",
        createInput: {
          projectId: "project-1",
          createRequestId: "create-stream-replay",
          model: { provider: "configured-provider", id: "configured-model" },
          thinkingLevel: "low",
        },
      },
      push: () => undefined,
      onSummaryChanged: () => undefined,
      resolvePi: async () => fakePi(),
    });

    try {
      const prompt = runtime.prompt({
        requestId: "stream-replay",
        projectId: "project-1",
        threadId: "session-stream-replay",
        text: "__stream_pause__",
        images: [],
      });
      await vi.waitFor(() => {
        expect(
          runtime
            .bootstrap()
            .events.some(
              ({ event }) => event.type === "message_update" && event.assistantMessageEvent.type === "text_delta",
            ),
        ).toBe(true);
      });

      const bootstrap = runtime.bootstrap();
      const store = new PiThreadStore(bootstrap.timeline);
      for (const { sequence, event } of bootstrap.events) store.apply(sequence, event);
      expect(store.getSnapshot()).toMatchObject({
        phase: "running",
        nodes: [
          { kind: "user", delivery: { state: "persisted" } },
          { kind: "assistant", content: [{ type: "text", text: "reply:" }], status: { type: "running" } },
        ],
      });

      await prompt;
      await vi.waitFor(() => expect(runtime.bootstrap().events).toEqual([]));
      expect(runtime.bootstrap().timeline.cursor).toBeGreaterThanOrEqual(store.getSnapshot().cursor);
    } finally {
      await runtime.dispose();
    }
  });

  it("closes the preflight-to-agent-start refresh window with authoritative RPC state", async () => {
    const runtime = await PiRpcSessionRuntime.create({
      binding: {
        mode: "create",
        projectId: "project-1",
        cwd: temporaryDirectory("desktop-pi-cwd-"),
        agentDir: temporaryDirectory("desktop-pi-user-data-"),
        sessionId: "session-delayed-start",
        createInput: {
          projectId: "project-1",
          createRequestId: "create-delayed-start",
          model: { provider: "configured-provider", id: "configured-model" },
          thinkingLevel: "low",
        },
      },
      push: () => undefined,
      onSummaryChanged: () => undefined,
      resolvePi: async () => fakePi(),
    });

    try {
      await runtime.prompt({
        requestId: "delayed-agent-start",
        projectId: "project-1",
        threadId: "session-delayed-start",
        text: "__delayed_agent_start__",
        images: [],
      });
      expect(runtime.bootstrap().timeline.phase).toBe("running");
      expect(runtime.threadSummary(false).running).toBe(true);
      await vi.waitFor(() => expect(runtime.bootstrap().timeline.phase).toBe("idle"));
    } finally {
      await runtime.dispose();
    }
  });

  it("projects generic system Pi extension UI without Desktop extension code", async () => {
    const userData = temporaryDirectory("desktop-pi-user-data-");
    const runtime = await PiRpcSessionRuntime.create({
      binding: {
        mode: "create",
        projectId: "project-1",
        cwd: temporaryDirectory("desktop-pi-cwd-"),
        agentDir: userData,
        sessionId: "session-extension-ui",
        createInput: {
          projectId: "project-1",
          createRequestId: "create-extension-ui",
          model: { provider: "configured-provider", id: "configured-model" },
          thinkingLevel: "low",
        },
      },
      push: () => undefined,
      onSummaryChanged: () => undefined,
      resolvePi: async () => fakePi(),
    });

    try {
      await runtime.prompt({
        requestId: "extension-ui",
        projectId: "project-1",
        threadId: "session-extension-ui",
        text: "__extension_ui__",
        images: [],
      });
      await vi.waitFor(() => {
        expect(runtime.bootstrap().control.hostRequests).toEqual([
          expect.objectContaining({ id: "confirm-1", type: "confirm", message: "Continue?" }),
          expect.objectContaining({ id: "select-1", type: "select", options: ["one", "two"] }),
          expect.objectContaining({ id: "input-1", type: "input", placeholder: "value" }),
          expect.objectContaining({ id: "editor-1", type: "editor", initialValue: "seed" }),
        ]);
        expect(runtime.bootstrap().control.extensionHost).toMatchObject({
          statuses: { sync: "同步中" },
          windowTitle: "Extension title",
          composerCommand: { mode: "replace", text: "replacement" },
          widgets: [{ key: "progress", lines: ["第一行", "第二行"], placement: "belowEditor" }],
        });
        expect(replayBootstrap(runtime.bootstrap()).nodes).toContainEqual(
          expect.objectContaining({
            kind: "notice",
            notificationType: "warning",
            content: { type: "text", text: "注意" },
          }),
        );
      });
      await runtime.respond({ requestId: "confirm-1", confirmed: true });
      await runtime.respond({ requestId: "select-1", value: "one" });
      await runtime.respond({ requestId: "input-1", value: "typed" });
      await runtime.respond({ requestId: "editor-1", value: "edited" });
      expect(runtime.bootstrap().control.hostRequests).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });

  it("preserves RPC extension errors across bootstrap replay", async () => {
    const runtime = await PiRpcSessionRuntime.create({
      binding: {
        mode: "create",
        projectId: "project-1",
        cwd: temporaryDirectory("desktop-pi-cwd-"),
        agentDir: temporaryDirectory("desktop-pi-user-data-"),
        sessionId: "session-extension-error",
        createInput: {
          projectId: "project-1",
          createRequestId: "create-extension-error",
          model: { provider: "configured-provider", id: "configured-model" },
          thinkingLevel: "low",
        },
      },
      push: () => undefined,
      onSummaryChanged: () => undefined,
      resolvePi: async () => fakePi(),
    });

    try {
      await runtime.prompt({
        requestId: "extension-error",
        projectId: "project-1",
        threadId: "session-extension-error",
        text: "__extension_error__",
        images: [],
      });
      expect(replayBootstrap(runtime.bootstrap()).nodes).toContainEqual(
        expect.objectContaining({
          kind: "notice",
          notificationType: "error",
          extensionNotification: {
            customType: "pi.extension_error",
            details: {
              extensionPath: "/extensions/broken.ts",
              event: "tool_call",
              error: "extension failed",
            },
          },
        }),
      );
    } finally {
      await runtime.dispose();
    }
  });
});

describe("loadSystemPiDraftConfig", () => {
  it("rejects outdated Pi before launching the draft RPC worker", async () => {
    await expect(
      loadSystemPiDraftConfig(
        temporaryDirectory("desktop-pi-cwd-"),
        temporaryDirectory("desktop-pi-user-data-"),
        async () => ({ ...fakePi(), version: "0.84.2-beta.1" }),
      ),
    ).rejects.toThrow("install 0.84.2 or newer");
  });

  it("uses Pi 0.84 command metadata without the removed acceptsArguments field", async () => {
    const config = await loadSystemPiDraftConfig(
      temporaryDirectory("desktop-pi-cwd-"),
      temporaryDirectory("desktop-pi-user-data-"),
      async () => fakePi(),
    );
    expect(config.commands).toContainEqual({
      name: "extension-command",
      description: "Extension command",
      source: "extension",
    });
  });

  it("loads thinking levels independently for every model", async () => {
    const config = await loadSystemPiDraftConfig(
      temporaryDirectory("desktop-pi-cwd-"),
      temporaryDirectory("desktop-pi-user-data-"),
      async () => fakePi(),
    );

    expect(config.models).toEqual([
      expect.objectContaining({
        provider: "fake-provider",
        id: "fake-model",
        thinkingLevels: ["off", "low", "high"],
      }),
      expect.objectContaining({
        provider: "custom-provider",
        id: "custom-reasoning-model",
        thinkingLevels: ["off", "high", "max"],
      }),
    ]);
  });
});

describe("PiRpcClient", () => {
  it("handshakes and uses an isolated Pi userData directory", async () => {
    const userData = temporaryDirectory("desktop-pi-user-data-");
    const events: Record<string, unknown>[] = [];
    const { client, handshake } = await PiRpcClient.launch({
      pi: fakePi(),
      cwd: temporaryDirectory("desktop-pi-cwd-"),
      environment: { ...process.env, PI_CODING_AGENT_DIR: userData },
      onEvent: (event) => events.push(event),
    });

    try {
      expect(handshake.state).toMatchObject({
        sessionId: "fake-session",
        isStreaming: false,
        userData,
      });
      expect(handshake.entries).toEqual({ entries: [], leafId: null });
      expect(client.version).toBe("0.84.2");

      const response = await client.request({ type: "echo", value: "payload" });
      expect(response.data).toEqual({ value: "payload" });
      expect(events).toEqual([{ type: "queue_update", steering: ["left right €"], followUp: [] }]);
    } finally {
      await client.close();
    }
  });

  it("ignores a late response after request timeout without terminating the session", async () => {
    const userData = temporaryDirectory("desktop-pi-user-data-");
    const { client } = await PiRpcClient.launch({
      pi: fakePi(),
      cwd: temporaryDirectory("desktop-pi-cwd-"),
      environment: { ...process.env, PI_CODING_AGENT_DIR: userData },
    });

    try {
      await expect(client.request({ type: "delayed" }, 5)).rejects.toThrow("timed out after 5ms");
      await new Promise((resolve) => setTimeout(resolve, 75));
      await expect(client.request({ type: "echo", value: "still-alive" })).resolves.toMatchObject({
        data: { value: "still-alive" },
      });
    } finally {
      await client.close();
    }
  });

  it("rejects non-object JSON messages during startup", async () => {
    const userData = temporaryDirectory("desktop-pi-user-data-");
    await expect(
      PiRpcClient.launch({
        pi: fakePi(),
        cwd: temporaryDirectory("desktop-pi-cwd-"),
        environment: { ...process.env, PI_CODING_AGENT_DIR: userData, FAKE_PI_PRIMITIVE: "1" },
      }),
    ).rejects.toThrow("System Pi emitted a non-object JSONL message");
  });

  it("rejects protocol pollution during startup", async () => {
    const userData = temporaryDirectory("desktop-pi-user-data-");
    await expect(
      PiRpcClient.launch({
        pi: fakePi(),
        cwd: temporaryDirectory("desktop-pi-cwd-"),
        environment: { ...process.env, PI_CODING_AGENT_DIR: userData, FAKE_PI_MALFORMED: "1" },
      }),
    ).rejects.toThrow("System Pi emitted invalid JSONL");
  });
});

function replayBootstrap(bootstrap: SessionBootstrap) {
  const store = new PiThreadStore(bootstrap.timeline);
  for (const { sequence, event } of bootstrap.events) store.apply(sequence, event);
  return store.getSnapshot();
}
