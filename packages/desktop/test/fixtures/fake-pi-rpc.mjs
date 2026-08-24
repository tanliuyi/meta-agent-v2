import { appendFileSync, writeFileSync } from "node:fs";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { createInterface } from "node:readline";
import { join } from "node:path";

if (process.argv.includes("--version")) {
  process.stdout.write("0.84.2\n");
  process.exit(0);
}

const modeIndex = process.argv.indexOf("--mode");
if (modeIndex === -1 || process.argv[modeIndex + 1] !== "rpc") {
  process.stderr.write("missing --mode rpc\n");
  process.exit(2);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const userData = process.env.PI_CODING_AGENT_DIR ?? null;
const requestedSession = argument("--session");
const sessionId = argument("--session-id") ?? "fake-session";
let activeSessionId = sessionId;
let sessionFile = requestedSession ?? join(userData ?? process.cwd(), `${sessionId}.jsonl`);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
if (process.env.FAKE_PI_ENV_LOG) {
  writeFileSync(
    process.env.FAKE_PI_ENV_LOG,
    JSON.stringify({
      projectId: process.env.PI_BROWSER_SESSION_PROJECT_ID ?? null,
      threadId: process.env.PI_BROWSER_SESSION_THREAD_ID ?? null,
      token: process.env.PI_BROWSER_SESSION_TOKEN ?? null,
    }),
  );
}
const entries = [];
let leafId = null;
let sessionName;
let thinkingLevel = "off";
let isStreaming = false;
let identityChanged = false;
const models = [
  {
    provider: "fake-provider",
    id: "fake-model",
    name: "Fake Model",
    contextWindow: 100000,
    reasoning: true,
    thinkingLevelMap: { minimal: null, medium: null },
  },
  {
    provider: "custom-provider",
    id: "custom-reasoning-model",
    name: "Custom Reasoning Model",
    contextWindow: 200000,
    reasoning: true,
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" },
  },
];
let model = models[0];
let lastTimestamp = Date.now();

function timestampNow() {
  lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
  return lastTimestamp;
}

function modelThinkingLevels(provider, modelId) {
  const selected = models.find((candidate) => candidate.provider === provider && candidate.id === modelId);
  return getSupportedThinkingLevels(selected ?? model);
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function response(request, data) {
  write({ id: request.id, type: "response", command: request.type, success: true, ...(data === undefined ? {} : { data }) });
}

function state() {
  return {
    sessionId: identityChanged ? `${sessionId}-changed` : activeSessionId,
    sessionFile,
    sessionName,
    model,
    thinkingLevel,
    isStreaming,
    isCompacting: false,
    steeringMode: "all",
    followUpMode: "all",
    autoCompactionEnabled: true,
    messageCount: entries.length,
    pendingMessageCount: 0,
    userData,
  };
}

function sessionStats() {
  const lastAssistant = entries.findLast(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  );
  const tokens = lastAssistant?.message.usage.totalTokens ?? 0;
  return {
    sessionFile,
    sessionId,
    userMessages: entries.filter((entry) => entry.type === "message" && entry.message.role === "user").length,
    assistantMessages: entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: entries.filter((entry) => entry.type === "message").length,
    tokens: { input: tokens > 0 ? 1 : 0, output: tokens > 0 ? 1 : 0, cacheRead: 0, cacheWrite: 0, total: tokens },
    cost: 0,
    contextUsage: { tokens, contextWindow: model.contextWindow, percent: (tokens / model.contextWindow) * 100 },
  };
}

function appendStateEntry(entry) {
  const persisted = {
    ...entry,
    id: `entry-${entries.length + 1}`,
    parentId: leafId,
    timestamp: new Date(timestampNow()).toISOString(),
  };
  entries.push(persisted);
  leafId = persisted.id;
}

function appendMessage(message) {
  const entry = {
    type: "message",
    id: `entry-${entries.length + 1}`,
    parentId: leafId,
    timestamp: new Date(message.timestamp).toISOString(),
    message,
  };
  entries.push(entry);
  leafId = entry.id;
  return entry;
}

function emitExtensionUi() {
  write({ type: "extension_ui_request", id: "confirm-1", method: "confirm", title: "Confirm", message: "Continue?" });
  write({ type: "extension_ui_request", id: "select-1", method: "select", title: "Select", options: ["one", "two"] });
  write({ type: "extension_ui_request", id: "input-1", method: "input", title: "Input", placeholder: "value" });
  write({ type: "extension_ui_request", id: "editor-1", method: "editor", title: "Edit", prefill: "seed" });
  write({ type: "extension_ui_request", id: "status-1", method: "setStatus", statusKey: "sync", statusText: "同步中" });
  write({
    type: "extension_ui_request",
    id: "widget-1",
    method: "setWidget",
    widgetKey: "progress",
    widgetLines: ["第一行", "第二行"],
    widgetPlacement: "belowEditor",
  });
  write({ type: "extension_ui_request", id: "title-1", method: "setTitle", title: "Extension title" });
  write({ type: "extension_ui_request", id: "editor-text-1", method: "set_editor_text", text: "replacement" });
  write({ type: "extension_ui_request", id: "notify-1", method: "notify", notifyType: "warning", message: "注意" });
}

input.on("line", (line) => {
  const request = JSON.parse(line);
  if (process.env.FAKE_PI_COMMAND_LOG) appendFileSync(process.env.FAKE_PI_COMMAND_LOG, `${request.type}\n`);
  if (process.env.FAKE_PI_MALFORMED === "1") {
    process.stdout.write("not-json\n");
    return;
  }
  if (process.env.FAKE_PI_PRIMITIVE === "1") {
    process.stdout.write("42\n");
    return;
  }

  switch (request.type) {
    case "get_state":
      response(request, state());
      break;
    case "get_entries": {
      const cursorIndex = request.since ? entries.findIndex((entry) => entry.id === request.since) : -1;
      response(request, { entries: request.since ? entries.slice(cursorIndex + 1) : entries, leafId });
      break;
    }
    case "get_session_stats":
      response(request, sessionStats());
      break;
    case "get_commands":
      response(request, {
        commands: [{ name: "extension-command", description: "Extension command", source: "extension", sourceInfo: {} }],
      });
      break;
    case "get_available_models":
      response(request, { models });
      break;
    case "get_available_thinking_levels":
      response(request, { levels: modelThinkingLevels(model.provider, model.id) });
      break;
    case "set_model": {
      const previousThinkingLevel = thinkingLevel;
      model =
        models.find((candidate) => candidate.provider === request.provider && candidate.id === request.modelId) ?? {
          ...model,
          provider: request.provider,
          id: request.modelId,
          name: `${request.provider}/${request.modelId}`,
        };
      thinkingLevel = clampThinkingLevel(model, thinkingLevel);
      appendStateEntry({ type: "model_change", provider: model.provider, modelId: model.id });
      if (thinkingLevel !== previousThinkingLevel) {
        appendStateEntry({ type: "thinking_level_change", thinkingLevel });
        write({ type: "thinking_level_changed", level: thinkingLevel });
      }
      response(request, model);
      break;
    }
    case "set_thinking_level": {
      const previousThinkingLevel = thinkingLevel;
      thinkingLevel = clampThinkingLevel(model, request.level);
      if (thinkingLevel !== previousThinkingLevel) {
        appendStateEntry({ type: "thinking_level_change", thinkingLevel });
        write({ type: "thinking_level_changed", level: thinkingLevel });
      }
      response(request);
      break;
    }
    case "set_session_name":
      sessionName = request.name;
      response(request);
      write({ type: "session_info_changed", name: sessionName });
      break;
    case "fork": {
      const index = entries.findIndex((entry) => entry.id === request.entryId);
      const selected = entries[index];
      if (index === -1 || selected?.type !== "message" || selected.message.role !== "user") {
        write({ id: request.id, type: "response", command: request.type, success: false, error: "Invalid entry ID" });
        break;
      }
      const text = typeof selected.message.content === "string" ? selected.message.content : "";
      entries.splice(index);
      leafId = entries.at(-1)?.id ?? null;
      activeSessionId = `${sessionId}-fork`;
      sessionFile = join(userData ?? process.cwd(), `${activeSessionId}.jsonl`);
      writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: activeSessionId, cwd: process.cwd() })}\n`);
      response(request, { text, cancelled: false });
      break;
    }
    case "abort":
      response(request);
      break;
    case "compact":
      write({ type: "compaction_start", reason: "manual" });
      response(request, {});
      write({
        type: "compaction_end",
        reason: "manual",
        result: {},
        aborted: false,
        willRetry: false,
      });
      break;
    case "prompt": {
      response(request);
      if (request.message === "__extension_ui__") {
        emitExtensionUi();
        break;
      }
      if (request.message === "__extension_error__") {
        write({
          type: "extension_error",
          extensionPath: "/extensions/broken.ts",
          event: "tool_call",
          error: "extension failed",
        });
        break;
      }
      if (request.message.startsWith("/extension-command")) {
        if (process.env.FAKE_PI_EXTENSION_NAVIGATE === "1") {
          appendMessage({ role: "user", content: "extension navigation", timestamp: timestampNow() });
        }
        break;
      }
      if (request.message === "__summarization_retry__") {
        setTimeout(() => {
          write({
            type: "summarization_retry_scheduled",
            attempt: 1,
            maxAttempts: 3,
            delayMs: 100,
            errorMessage: "overloaded",
          });
        }, 10);
        setTimeout(() => {
          write({ type: "summarization_retry_attempt_start", source: "compaction", reason: "threshold" });
        }, 60);
        setTimeout(() => write({ type: "summarization_retry_finished" }), 110);
        break;
      }
      isStreaming = true;
      const runAgent = async () => {
        write({ type: "agent_start" });
        const user = { role: "user", content: request.message, timestamp: timestampNow() };
        write({ type: "message_start", message: user });
        appendMessage(user);
        write({ type: "message_end", message: user });
        const assistantBase = {
          role: "assistant",
          api: "fake-api",
          provider: model.provider,
          model: model.id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          timestamp: timestampNow(),
        };
        const started = { ...assistantBase, content: [], stopReason: "pending" };
        const assistant = { ...assistantBase, content: [{ type: "text", text: `reply:${request.message}` }], stopReason: "stop" };
        write({ type: "message_start", message: started });
        write({
          type: "message_update",
          usage: assistantBase.usage,
          assistantMessageEvent: { type: "text_start", contentIndex: 0 },
        });
        write({
          type: "message_update",
          usage: assistantBase.usage,
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "reply:" },
        });
        if (request.message === "__stream_pause__") {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        write({
          type: "message_update",
          usage: assistantBase.usage,
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: request.message },
        });
        write({
          type: "message_update",
          usage: assistantBase.usage,
          assistantMessageEvent: {
            type: "text_end",
            contentIndex: 0,
            content: `reply:${request.message}`,
          },
        });
        appendMessage(assistant);
        write({ type: "message_end", message: assistant });
        isStreaming = false;
        if (process.env.FAKE_PI_IDENTITY_AFTER_PROMPT === "1") identityChanged = true;
        write({ type: "agent_settled" });
      };
      if (request.message === "__delayed_agent_start__") setTimeout(() => void runAgent(), 50);
      else void runAgent();
      break;
    }
    case "extension_ui_response":
      break;
    case "emit_extension_ui":
      response(request);
      emitExtensionUi();
      break;
    case "block_stdin":
      response(request);
      input.pause();
      break;
    case "delayed":
      setTimeout(() => response(request, { delayed: true }), 50);
      break;
    case "echo": {
      const event = Buffer.from(`${JSON.stringify({ type: "queue_update", steering: ["left right €"], followUp: [] })}\n`, "utf8");
      const euro = event.indexOf(Buffer.from("€", "utf8"));
      process.stdout.write(event.subarray(0, euro + 1));
      setTimeout(() => {
        process.stdout.write(event.subarray(euro + 1));
        response(request, { value: request.value });
      }, 5);
      break;
    }
    default:
      write({ id: request.id, type: "response", command: request.type, success: false, error: "unknown command" });
  }
});
