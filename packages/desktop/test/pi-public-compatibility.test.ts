import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  type AgentSession,
  type AgentSessionEvent,
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("Pi coding-agent 0.80.7 public compatibility", () => {
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
  const faux = registerFauxProvider({ tokensPerSecond: 100_000 });
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider(faux.getModel().provider, {
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
    authStorage,
    modelRegistry,
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
