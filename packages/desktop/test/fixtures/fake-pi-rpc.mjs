import { createInterface } from "node:readline";
import { join } from "node:path";

if (process.argv.includes("--version")) {
  process.stdout.write("0.83.0\n");
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
const sessionFile = requestedSession ?? join(userData ?? process.cwd(), `${sessionId}.jsonl`);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const entries = [];
let leafId = null;
let sessionName;
let thinkingLevel = "off";
let isStreaming = false;
let model = {
  provider: "fake-provider",
  id: "fake-model",
  name: "Fake Model",
  contextWindow: 100000,
  reasoning: true,
};

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function response(request, data) {
  write({ id: request.id, type: "response", command: request.type, success: true, ...(data === undefined ? {} : { data }) });
}

function state() {
  return {
    sessionId,
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

input.on("line", (line) => {
  const request = JSON.parse(line);
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
    case "get_entries":
      response(request, { entries, leafId });
      break;
    case "get_commands":
      response(request, {
        commands: [{ name: "no-args", description: "No args", source: "extension", acceptsArguments: false }],
      });
      break;
    case "get_available_models":
      response(request, { models: [model] });
      break;
    case "get_available_thinking_levels":
      response(request, { levels: ["off", "low", "high"] });
      break;
    case "set_model":
      model = { ...model, provider: request.provider, id: request.modelId, name: `${request.provider}/${request.modelId}` };
      response(request, model);
      break;
    case "set_thinking_level":
      thinkingLevel = request.level;
      response(request);
      break;
    case "set_session_name":
      sessionName = request.name;
      response(request);
      write({ type: "session_info_changed", name: sessionName });
      break;
    case "abort":
      response(request);
      break;
    case "compact":
      write({ type: "compaction_start", reason: "manual" });
      response(request, {});
      write({ type: "compaction_end", willRetry: false });
      break;
    case "prompt": {
      response(request);
      if (request.message === "__extension_ui__") {
        write({ type: "extension_ui_request", id: "editor-1", method: "editor", title: "Edit", prefill: "seed" });
        write({ type: "extension_ui_request", id: "status-1", method: "setStatus", statusKey: "sync", statusText: "同步中" });
        write({ type: "extension_ui_request", id: "notify-1", method: "notify", notifyType: "warning", message: "注意" });
        break;
      }
      isStreaming = true;
      write({ type: "agent_start" });
      const user = { role: "user", content: request.message, timestamp: Date.now() };
      appendMessage(user);
      write({ type: "message_end", message: user });
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: `reply:${request.message}` }],
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
        stopReason: "stop",
        timestamp: Date.now() + 1,
      };
      appendMessage(assistant);
      write({ type: "message_end", message: assistant });
      isStreaming = false;
      write({ type: "agent_settled" });
      break;
    }
    case "extension_ui_response":
      break;
    case "emit_extension_ui":
      response(request);
      write({ type: "extension_ui_request", id: "editor-1", method: "editor", title: "Edit", prefill: "seed" });
      write({ type: "extension_ui_request", id: "status-1", method: "setStatus", statusKey: "sync", statusText: "同步中" });
      write({ type: "extension_ui_request", id: "notify-1", method: "notify", notifyType: "warning", message: "注意" });
      break;
    case "block_stdin":
      response(request);
      input.pause();
      break;
    case "delayed":
      setTimeout(() => response(request, { delayed: true }), 50);
      break;
    case "echo": {
      const event = Buffer.from(`${JSON.stringify({ type: "message_update", text: "left right €" })}\n`, "utf8");
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
