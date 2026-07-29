import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import {
  type BuiltinProvider,
  fauxAssistantMessage,
  fauxToolCall,
  getModels,
  getProviders,
  registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModelsConfigMetadata } from "../src/main/models/models-config-metadata.ts";
import { parseModelsConfigSource } from "../src/main/models/models-config-schema.ts";

describe("Pi coding-agent 0.82.1 public compatibility", () => {
  let harness: Awaited<ReturnType<typeof createPublicHarness>>;

  beforeEach(async () => {
    harness = await createPublicHarness();
  });

  afterEach(async () => {
    harness.session.dispose();
    harness.faux.unregister();
    await rm(harness.tempDir, { recursive: true, force: true });
  });

  it("idle prompt 先通过 preflight，并由 public branch 持久化普通 user/assistant message", async () => {
    harness.faux.setResponses([fauxAssistantMessage("answer")]);
    let accepted: boolean | undefined;

    await harness.session.prompt("question", {
      preflightResult: (success) => {
        accepted = success;
      },
    });

    expect(accepted).toBe(true);
    expect(harness.events.filter(({ type }) => type === "entry_appended")).toEqual([]);
    const messages = harness.session.sessionManager
      .getBranch()
      .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
    expect(messages.map(({ role }) => role)).toEqual(["user", "assistant"]);
    expect(messages.map(messageText)).toEqual(["question", "answer"]);
    expect(harness.events.filter(({ type }) => type === "message_start").map(({ message }) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("loads a realistic Desktop models.json through the public ModelRuntime contract", async () => {
    const modelsPath = join(harness.tempDir, "models.json");
    const source = JSON.stringify(
      {
        providers: {
          openai: {
            modelOverrides: {
              "gpt-5.5": { name: "Desktop Override", maxTokens: 4096 },
            },
          },
          "desktop-contract": {
            name: "Desktop Contract",
            baseUrl: "https://models.example.test/v1",
            api: "openai-completions",
            apiKey: "contract-key",
            headers: { "X-Desktop": "contract" },
            compat: { supportsDeveloperRole: true, maxTokensField: "max_tokens" },
            models: [
              {
                id: "desktop-model",
                name: "Desktop Model",
                reasoning: true,
                thinkingLevelMap: { off: null, high: "high" },
                input: ["text", "image"],
                cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
                contextWindow: 128000,
                maxTokens: 8192,
                headers: { "X-Model": "contract" },
                compat: { supportsStrictMode: true },
              },
            ],
          },
        },
      },
      null,
      2,
    );
    await writeFile(modelsPath, source, "utf8");
    const parsed = parseModelsConfigSource(source, modelsPath);
    expect(parsed.ok).toBe(true);

    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath,
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
    });

    expect(runtime.getError()).toBeUndefined();
    expect(runtime.getModel("anthropic", "claude-opus-4-8")).toBeDefined();
    expect(runtime.getModel("openai", "gpt-5.5")).toEqual(
      expect.objectContaining({ name: "Desktop Override", maxTokens: 4096 }),
    );
    const desktopModel = runtime.getModel("desktop-contract", "desktop-model");
    expect(desktopModel).toEqual(
      expect.objectContaining({
        thinkingLevelMap: { off: null, high: "high" },
        compat: expect.objectContaining({ supportsDeveloperRole: true, supportsStrictMode: true }),
      }),
    );
    expect(desktopModel ? (await runtime.getAuth(desktopModel))?.auth.headers : undefined).toEqual({
      "X-Desktop": "contract",
      "X-Model": "contract",
    });
  });

  it("preserves all public built-in model metadata used by the Desktop editor", () => {
    const metadata = getModelsConfigMetadata();
    const sourceModels = getProviders().flatMap((provider) => getModels(provider as BuiltinProvider));
    expect(metadata.builtInProviders.find(({ id }) => id === "google-vertex")?.displayName).toBe("Google Vertex AI");
    expect(metadata.builtInProviders.find(({ id }) => id === "opencode")?.displayName).toBe("OpenCode Zen");
    expect(metadata.builtInProviders.find(({ id }) => id === "radius")).toEqual(
      expect.objectContaining({ displayName: "Radius", models: [] }),
    );
    for (const field of ["thinkingLevelMap", "headers", "compat"] as const) {
      const sourceModel = sourceModels.find((model) => model[field] !== undefined);
      expect(sourceModel, `missing built-in model fixture for ${field}`).toBeDefined();
      const projected = metadata.builtInProviders
        .find(({ id }) => id === sourceModel?.provider)
        ?.models.find(({ id }) => id === sourceModel?.id);
      expect(projected?.name).toBe(sourceModel?.name);
      expect(projected?.[field]).toEqual(sourceModel?.[field]);
    }
  });

  it("runs controlled commands, input events, and custom messages through public Pi APIs", async () => {
    await harness.session.prompt("/desktop-test argument");
    expect(harness.extensionObservations).toContain("command:argument");

    harness.faux.setResponses([fauxAssistantMessage("event answer")]);
    await harness.session.prompt("event input");
    expect(harness.extensionObservations).toContain("input:event input");

    await harness.session.sendCustomMessage({
      customType: "desktop-test",
      content: "custom content",
      display: true,
      details: { controlled: true },
    });
    expect(harness.session.messages).toContainEqual(
      expect.objectContaining({ role: "custom", customType: "desktop-test" }),
    );
  });

  it("runs an extension tool and preserves Pi tool lifecycle events", async () => {
    harness.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("desktop_echo", { text: "hello" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("tool complete"),
    ]);

    await harness.session.prompt("use the tool");

    expect(harness.events).toContainEqual(
      expect.objectContaining({ type: "tool_execution_start", toolName: "desktop_echo" }),
    );
    expect(harness.events).toContainEqual(
      expect.objectContaining({ type: "tool_execution_end", toolName: "desktop_echo", isError: false }),
    );
    expect(harness.session.messages.some(({ role }) => role === "toolResult")).toBe(true);
  });

  it("aborts a public Pi run and settles with an aborted assistant message", async () => {
    harness.faux.setResponses([fauxAssistantMessage("x".repeat(20_000))]);
    const running = harness.session.prompt("abort this");
    await vi.waitFor(() => expect(harness.events.some(({ type }) => type === "message_update")).toBe(true));

    await harness.session.abort();
    await running;

    expect(harness.events.at(-1)?.type).toBe("agent_settled");
    expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
  });

  it("allows a controlled extension to provide public compaction output", async () => {
    harness.faux.setResponses([fauxAssistantMessage("one answer"), fauxAssistantMessage("two answer")]);
    await harness.session.prompt("one");
    await harness.session.prompt("two");

    const result = await harness.session.compact();

    expect(result.summary).toBe("desktop extension summary");
    expect(harness.session.messages[0]?.role).toBe("compactionSummary");
  });

  it("running prompt 的 queue_update removal 先于 consumed user message_start", async () => {
    let releaseFirst: ((message: ReturnType<typeof fauxAssistantMessage>) => void) | undefined;
    const firstResponse = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
      releaseFirst = resolve;
    });
    harness.faux.setResponses([() => firstResponse, fauxAssistantMessage("after steer")]);
    const running = harness.session.prompt("first");
    await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));

    await harness.session.prompt("queued", { streamingBehavior: "steer" });
    expect(harness.session.getSteeringMessages()).toEqual(["queued"]);
    releaseFirst?.(fauxAssistantMessage("first answer"));
    await running;

    const added = harness.events.findIndex(
      (event) => event.type === "queue_update" && event.steering.includes("queued"),
    );
    const removed = harness.events.findIndex(
      (event, index) => index > added && event.type === "queue_update" && event.steering.length === 0,
    );
    const consumed = harness.events.findIndex(
      (event, index) => index > removed && event.type === "message_start" && messageText(event.message) === "queued",
    );
    expect(added).toBeGreaterThanOrEqual(0);
    expect(removed).toBeGreaterThan(added);
    expect(consumed).toBeGreaterThan(removed);
  });
});

async function createPublicHarness() {
  const tempDir = join(tmpdir(), `desktop-pi-public-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tempDir, { recursive: true });
  const faux = registerFauxProvider({ tokensPerSecond: 100_000 });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider(faux.getModel().provider, {
    baseUrl: faux.getModel().baseUrl,
    apiKey: "faux-key",
    api: faux.api,
    models: faux.models.map((model) => ({
      id: model.id,
      name: model.name,
      api: model.api,
      baseUrl: model.baseUrl,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  });
  await modelRuntime.refresh({ allowNetwork: false });
  const settingsManager = SettingsManager.inMemory({ compaction: { keepRecentTokens: 1 } });
  const extensionObservations: string[] = [];
  const resourceLoader = new DefaultResourceLoader({
    cwd: tempDir,
    agentDir: tempDir,
    settingsManager,
    noExtensions: true,
    extensionFactories: [
      {
        name: "desktop:compatibility-characterization",
        factory: (pi) => {
          pi.registerCommand("desktop-test", {
            description: "Desktop compatibility command",
            handler: async (args) => extensionObservations.push(`command:${args}`),
          });
          pi.on("input", (event) => {
            extensionObservations.push(`input:${event.text}`);
          });
          pi.on("session_before_compact", async (event) => ({
            compaction: {
              summary: "desktop extension summary",
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
              details: { source: "desktop-test" },
            },
          }));
          pi.registerTool({
            name: "desktop_echo",
            label: "Desktop echo",
            description: "Echo controlled extension input",
            parameters: Type.Object({ text: Type.String() }),
            execute: async (_toolCallId, input) => ({
              content: [{ type: "text", text: input.text }],
              details: {},
            }),
          });
        },
      },
    ],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: tempDir,
    agentDir: tempDir,
    modelRuntime,
    model: faux.getModel(),
    noTools: "builtin",
    resourceLoader,
    sessionManager: SessionManager.inMemory(tempDir),
    settingsManager,
  });
  await session.bindExtensions({});
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  return { tempDir, faux, session, events, extensionObservations };
}

function messageText(message: AgentSession["messages"][number]): string {
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}
