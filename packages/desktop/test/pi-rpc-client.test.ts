import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionPushPayload } from "../src/shared/contracts.ts";
import { PiRpcClient } from "../src/sidecar/pi-rpc-client.ts";
import { PiRpcSessionRuntime } from "../src/sidecar/pi-rpc-session-runtime.ts";
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
    version: "0.83.0",
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

    expect(resolveSystemPi({ PATH: `${delimiter}${root}` }, "linux")).toEqual({
      command: executable,
      argsPrefix: [],
      executablePath: executable,
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

    expect(resolveSystemPi({ Path: root }, "win32")).toEqual({
      command: join(root, "node.exe"),
      argsPrefix: [cliPath],
      executablePath: join(root, "pi.cmd"),
      packageRoot,
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

    expect(resolveSystemPi({ PATH: `${root}${delimiter}${nodeRoot}` }, "win32")).toMatchObject({
      command: join(nodeRoot, "node.exe"),
      argsPrefix: [cliPath],
      executablePath: join(root, "pi.cmd"),
      packageRoot,
    });
  });

  it("does not resolve relative or empty PATH entries", () => {
    expect(() => resolveSystemPi({ PATH: `${delimiter}.` }, "linux")).toThrow(
      "Unable to find a runnable system Pi CLI in PATH",
    );
  });
});

describe("PiRpcSessionRuntime", () => {
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
      expect(pushes.some((payload) => payload.type === "timeline")).toBe(true);
      expect(runtime.threadSummary(false)).toMatchObject({ title: "hello", messageCount: 2, running: false });

      await runtime.compact();
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
          expect.objectContaining({ id: "editor-1", type: "editor", initialValue: "seed" }),
        ]);
        expect(runtime.bootstrap().control.extensionHost.statuses).toEqual({ sync: "同步中" });
        expect(runtime.bootstrap().timeline.nodes).toContainEqual(
          expect.objectContaining({
            kind: "notice",
            notificationType: "warning",
            content: { type: "text", text: "注意" },
          }),
        );
      });
      await runtime.respond({ requestId: "editor-1", value: "edited" });
      expect(runtime.bootstrap().control.hostRequests).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });
});

describe("loadSystemPiDraftConfig", () => {
  it("uses the RPC acceptsArguments field for slash commands", async () => {
    const config = await loadSystemPiDraftConfig(
      temporaryDirectory("desktop-pi-cwd-"),
      temporaryDirectory("desktop-pi-user-data-"),
      async () => fakePi(),
    );
    expect(config.commands).toContainEqual({
      name: "no-args",
      description: "No args",
      source: "extension",
      acceptsArguments: false,
    });
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
      expect(client.version).toBe("0.83.0");

      const response = await client.request({ type: "echo", value: "payload" });
      expect(response.data).toEqual({ value: "payload" });
      expect(events).toEqual([{ type: "message_update", text: "left right €" }]);
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
