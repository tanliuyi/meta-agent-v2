import { fileURLToPath } from "node:url";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  SessionMessageEntry,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { CoreMessage, NudgeDecision, CompressionBlock } from "acp-kernel";
import { renderNudgeText } from "acp-kernel";
import type { AdapterConfig } from "./config.ts";
import { createRuntime, type AcpRuntime } from "./runtime.ts";
import { makeCompressTool } from "./compress-tool.ts";
import { makeDecompressTool } from "./decompress-tool.ts";
import { makeSearchTool } from "./search-tool.ts";
import { makeStatusTool } from "./status-tool.ts";
import { makeCommands } from "./commands.ts";
import { coreOutToAgentMessages } from "./messages.ts";
import { ACP_SYSTEM_PROMPT } from "./system-prompt.ts";
import { registerAcpChildExtension } from "./subagent-child-extension.ts";
import { wireToolGuardrails } from "./tool-guardrails.ts";
import { debug, setDebugEnabled } from "./log.ts";
import { collectCoveredMessageIds, estimateTokens, lastUserMessageId } from "./tokens.ts";
import { checkForUpdate } from "./update.ts";
import { loadUserConfig, applyUserConfig, type UserAcpConfig } from "./user-config.ts";

type AgentMessage = SessionMessageEntry["message"];
type DesktopPluginTool = ToolDefinition;
type PluginMethodExecutionContext = {
  readonly pluginId: string;
  readonly methodName: string;
  readonly callId: string;
  readonly toolCallId: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly toolContext?: unknown;
  attach(attachment: { type: "image" | "file"; data?: string; path?: string; mimeType?: string; name?: string }): void;
  reportProgress(progress: unknown): void;
};

const declarationRuntime = createRuntime({});
const declarationTools = [
  makeCompressTool(declarationRuntime),
  makeDecompressTool(declarationRuntime),
  makeSearchTool(declarationRuntime),
  makeStatusTool(declarationRuntime),
];
const pluginResultSchema = Type.Object({ text: Type.String() }, { additionalProperties: false });
let activeRuntime: AcpRuntime | undefined;
let activeTools = new Map<string, DesktopPluginTool>();

export const desktopPlugin = {
  schemaVersion: 1 as const,
  methods: declarationTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    result: pluginResultSchema,
    concurrency: "serial" as const,
    async execute(
      params: unknown,
      signal: AbortSignal,
      ctx: PluginMethodExecutionContext,
    ): Promise<{ text: string }> {
      const runtime = activeRuntime;
      if (!runtime) throw new Error("Billion Context plugin is not active");
      const extensionContext = ctx.toolContext as ExtensionContext | undefined;
      if (!extensionContext) throw new Error("Plugin extension context is unavailable");
      const currentTool = activeTools.get(ctx.methodName);
      if (!currentTool) throw new Error(`Billion Context method ${ctx.methodName} is unavailable`);
      const result = await currentTool.execute(
        ctx.callId,
        params,
        signal,
        undefined,
        extensionContext,
      ) as AgentToolResult<unknown>;
      return { text: result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") };
    },
  })),
};

export const pluginCallCatalog = {
  schemaVersion: 1 as const,
  pluginId: "pi.billion-context",
  methods: [...desktopPlugin.methods]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, description, parameters, result, concurrency }) => ({
      name,
      description,
      parameters,
      result,
      concurrency,
    })),
};

type DesktopAcpConfiguration = Pick<
  AdapterConfig,
  "debug" | "modelContextLimit" | "preserveRecentMessages" | "toolBashDefaultTimeout" | "toolOutputMaxBytes"
>;

interface HostConfigurableExtensionAPI extends ExtensionAPI {
  getConfig<T = DesktopAcpConfiguration>(): Readonly<T>;
}

export function createAcpExtension(adapter: AdapterConfig = {}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const hostApi = pi as Partial<HostConfigurableExtensionAPI>;
    const hostConfig =
      typeof hostApi.getConfig === "function"
        ? hostApi.getConfig<DesktopAcpConfiguration>()
        : {};
    const hostConfigKeys = desktopHostConfigKeys(hostConfig);
    const runtime = createRuntime({ ...adapter, ...hostConfig });
    activeRuntime = runtime;
    activeTools = new Map([
      makeCompressTool(runtime),
      makeDecompressTool(runtime),
      makeSearchTool(runtime),
      makeStatusTool(runtime),
    ].map((tool) => [tool.name, tool]));
    registerAcpChildExtension(adapter.childExtensionPath ?? fileURLToPath(import.meta.url));
    wireCompactionDisable(pi);
    wireSessionLifecycle(pi, runtime, hostConfigKeys);
    wireContextTransform(pi, runtime);
    wireSystemPrompt(pi);
    wireToolGuardrails(pi, runtime);
    pi.on("session_shutdown", async () => {
      if (activeRuntime === runtime) activeRuntime = undefined;
    });
    for (const { name, options } of makeCommands(runtime)) {
      pi.registerCommand(name, options);
    }
  };
}

export default createAcpExtension();

// ACP owns compression; cancel Pi's built-in auto-compaction entirely (mirrors
// opencode-acp requiring opencode's compaction.auto = false).
function wireCompactionDisable(pi: ExtensionAPI): void {
  pi.on("session_before_compact", () => ({ cancel: true }));
}

function wireSessionLifecycle(
  pi: ExtensionAPI,
  runtime: AcpRuntime,
  hostConfigKeys: ReadonlySet<keyof UserAcpConfig>,
): void {
  pi.on("session_start", async (_event, ctx) => {
    runtime.store.invalidate();
    runtime.clearNudgeTracking();
    // Load user config (~/.pi/acp.json + project .pi/acp.json). Desktop values
    // already validated by the host remain authoritative for fields declared in
    // the manifest; standard Pi callers pass no protected keys.
    try {
      const user = await loadUserConfig(ctx.cwd);
      runtime.setAdapter(applyUserConfig(runtime.adapter, user, hostConfigKeys));
      if (runtime.adapter.debug !== undefined) setDebugEnabled(runtime.adapter.debug);
    } catch {
      // best-effort — fall back to factory/env config
    }
    void checkForUpdate(runtime.adapter.autoUpdate ?? true, (msg) => {
      if (ctx.hasUI) ctx.ui.notify(msg);
    });
  });
}

// The core integration: Pi's `context` event fires before every LLM call with the
// messages about to be sent. We run acp-kernel's processTurn (prune + ref-tag +
// nudge decision) and return the transformed AgentMessage[].
function wireContextTransform(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("context", async (event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    const release = await runtime.acquireLock(sid);
    try {
      const { state, coreMessages, entries } = await runtime.stateFor(ctx);
      const config = runtime.configFor(ctx);
      const coveredIds = collectCoveredMessageIds(state);
      // Prefer pi's real token count (anchored on provider usage) over our
      // chars/4 estimate — it includes the system prompt, tool schemas, and
      // trailing messages pi has not yet received a usage for. This is what the
      // footer percentage reflects, so nudge usage/growth will match what the
      // user sees.
      const realUsage = ctx.getContextUsage?.();
      const estimated = estimateTokens(coreMessages, coveredIds);
      const tokenCount = realUsage?.tokens && realUsage.tokens > 0 ? realUsage.tokens : estimated;

      debug.event("context-in", {
        sid,
        eventMsgs: event.messages?.length ?? 0,
        entries: entries.length,
        coreMsgs: coreMessages.length,
        tokenCount,
        estimatedTokens: estimated,
        realTokens: realUsage?.tokens ?? null,
        realPercent: realUsage?.percent ?? null,
        limit: config.modelContextLimit,
        blocksBefore: state.blocks.length,
        activeBefore: state.blocks.filter((b) => b.active).length,
      });

      const turn = runtime.core.processTurn({ messages: coreMessages, state, config, tokenCount });
      await runtime.save(turn.state, ctx);

      debug.event("processTurn", {
        outMsgs: turn.messages.length,
        summaryMsgs: turn.messages.filter((m) => m.id.startsWith("acp_summary")).length,
        prunedMsgs: coreMessages.length - turn.messages.length + turn.messages.filter((m) => m.id.startsWith("acp_summary")).length,
        nudgeShouldInject: turn.nudge?.shouldInject ?? false,
        nudgeReason: turn.nudge?.reason ?? null,
        nudgeVoice: turn.nudge ? renderNudgeText(turn.nudge).voice : null,
      nudgePct: turn.nudge ? Math.round(turn.nudge.contextUsage * 100) : null,
      nudgeTier: turn.nudge?.tier ?? null,
      nudgeCompressibleCount: turn.nudge?.compressibleRanges.length ?? 0,
      nudgeProtectedCount: turn.nudge?.protectedRanges?.length ?? 0,
      nothingToCompress: turn.nudge?.reason?.includes("nothing to compress") ?? false,
      blocksAfter: turn.state.blocks.length,
      activeAfter: turn.state.blocks.filter((b) => b.active).length,
    });

    const originalById = collectOriginals(entries);
    const rebuilt = coreOutToAgentMessages(turn.messages, originalById);
    const debugOn = debug.enabled;

    if (turn.nudge?.shouldInject) {
      // Two independent channels for the nudge:
      //  1. CONTEXT injection (always on): the nudge is appended to the
      //     messages returned to the LLM so the model sees it and compresses.
      //     This is a per-turn append — the next context event rebuilds the
      //     array from scratch, so it does NOT permanently pollute context.
      //  2. TERMINAL echo (debug only): when debug is on, also print the exact
      //     text via ctx.ui.notify so the user can observe what is being
      //     injected while debugging. The model never sees terminal output.
      // Emergency nudges (usage >= 80%) bypass the per-turn dedup so the
      // overflow warning always reaches the model. Other nudges inject at most
      // once per turn: pi fires the context event multiple times per assistant
      // reply (streaming/tool loop), and without this gate the same nudge
      // would be appended on every event.
      const emergency = turn.nudge.breakdown?.emergencyOverride === 1;
      const turnKey = lastUserMessageId(entries) ?? sid;
      const alreadyShown = !emergency && runtime.nudgeShownFor(turnKey);
      if (!alreadyShown) {
        rebuilt.push(nudgeMessage(turn.nudge, turn.state.blocks.filter((b) => b.active)));
        const rendered = renderNudgeText(turn.nudge);
        const top = [...turn.nudge.compressibleRanges].sort((a, b) => b.tokens - a.tokens)[0];
        const example = top ? `\n\nExample: compress({ content: [{ startId: "${top.startRef}", endId: "${top.endRef}", summary: "..." }] })` : "";
        if (debugOn && ctx.hasUI) {
          ctx.ui.notify(`[ACP nudge → context]${emergency ? " [EMERGENCY]" : ""}\n${rendered.text}${example}`);
        }
        if (!emergency) runtime.markNudgeShown(turnKey);
        debug.event("nudge-injected", { sid: ctx.sessionManager.getSessionId(), voice: rendered.voice, channels: ["context", debugOn ? "terminal" : null].filter(Boolean), emergency, turnKey, text: rendered.text + example });
      } else {
        debug.event("nudge-suppressed", { sid: ctx.sessionManager.getSessionId(), turnKey, reason: turn.nudge.reason });
      }
    }

    // Always return the transformed array: every message needs its [mNNNNN] ref
    // tag applied, so there is no meaningful "no change" case to short-circuit.
    debug.event("context-out", { outMsgs: rebuilt.length, injected: turn.nudge?.shouldInject ?? false, emergency: turn.nudge?.breakdown?.emergencyOverride === 1 });
    // Also check for updates here (not only on session_start): resuming a
    // long-running session never re-fires session_start, so an update could
    // go unnoticed for days. checkForUpdate throttles internally (3 min) and
    // is guarded against concurrent calls, so firing it per LLM call is safe.
    void checkForUpdate(runtime.adapter.autoUpdate ?? true, (msg) => {
      if (ctx.hasUI) ctx.ui.notify(msg);
    });
    return { messages: rebuilt };
    } finally {
      release();
    }
  });
}

function desktopHostConfigKeys(config: DesktopAcpConfiguration): ReadonlySet<keyof UserAcpConfig> {
  const keys = new Set<keyof UserAcpConfig>();
  if (config.debug !== undefined) keys.add("debug");
  if (config.modelContextLimit !== undefined) keys.add("modelContextLimit");
  if (config.toolBashDefaultTimeout !== undefined) keys.add("toolBashDefaultTimeout");
  if (config.toolOutputMaxBytes !== undefined) keys.add("toolOutputMaxBytes");
  return keys;
}

function wireSystemPrompt(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    return { systemPrompt: `${event.systemPrompt}\n\n${ACP_SYSTEM_PROMPT}` };
  });
}

function collectOriginals(entries: ReturnType<ExtensionContext["sessionManager"]["buildContextEntries"]>): Map<string, AgentMessage> {
  const map = new Map<string, AgentMessage>();
  for (const entry of entries) {
    if (entry.type === "message") {
      map.set(entry.id, entry.message);
    } else if (entry.type === "custom_message") {
      // Pi's convertToLlm projects custom messages as { role: "user", content }
      // for the LLM. Mirror that here so coreOutToAgentMessages restores a
      // proper user AgentMessage — using role:"custom" would be dropped by Pi.
      const content = typeof entry.content === "string"
        ? [{ type: "text" as const, text: entry.content }]
        : entry.content;
      map.set(entry.id, { role: "user", content } as AgentMessage);
    }
  }
  return map;
}

function nudgeMessage(nudge: NudgeDecision, blocks: CompressionBlock[]): AgentMessage {
  const rendered = renderNudgeText(nudge);
  const lines = [rendered.text];

  if (blocks.length > 0) {
    const totalSummary = blocks.reduce((s, b) => s + Math.ceil((b.summary || "").length / 4), 0);
    const totalCompressed = blocks.reduce((s, b) => s + (b.compressedTokens || 0), 0);
    const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`);
    const tierCounts: Record<number, number> = {};
    for (const b of blocks) {
      const t = b.tier ?? 1;
      tierCounts[t] = (tierCounts[t] || 0) + 1;
    }
    const tierStr = Object.keys(tierCounts).map(Number).sort().map((t) => `T${t}:${tierCounts[t]}`).join(" ");
    const ids = blocks.slice(0, 10).map((b) => b.blockId).join(", ");
    const extra = blocks.length > 10 ? ` (+${blocks.length - 10} more)` : "";
    lines.push("");
    lines.push(`Compressed blocks: ${blocks.length} active (${tierStr}) — ${fmt(totalSummary)} summary, ${fmt(totalCompressed)} original compressed. Blocks: ${ids}${extra}.`);
  }

  return {
    role: "user",
    content: [{ type: "text", text: lines.join("\n") }],
    timestamp: Date.now(),
  } as AgentMessage;
}
