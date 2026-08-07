/**
 * pi-auto-title: automatic LLM-generated session titles for the Desktop app.
 *
 * New sessions get a local title immediately from the first meaningful prompt.
 * The first prompt is then refined by the configured model, and the title is
 * refined once more after the third meaningful user prompt using the current
 * conversation. Generation is always fire-and-forget and never delays the
 * main agent turn.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple, type Message } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AutoTitleSettings } from "../../../../shared/auto-title-contracts.ts";
import { loadAutoTitleConfig } from "./config.ts";

const TITLE_TIMEOUT_MS = 20_000;
const TITLE_REFINEMENT_MESSAGE_COUNT = 3;
const MAX_CONVERSATION_TEXT = 1_000;

const SYNTHETIC_BLOCK_PATTERN =
  /<(local-command-stdout|command-message|command-name|bash-input|session-start-hook|ide_opened_file)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi;
const SYNTHETIC_TAG_PATTERN =
  /<\/?(?:local-command-stdout|command-message|command-name|bash-input|session-start-hook|ide_opened_file)(?:\s[^>]*)?>/gi;

const TITLE_FORMAT_INSTRUCTIONS =
  '输出一个 JSON 对象，格式严格为 {"title":"..."}。只填写 title 字段，不要 Markdown、解释、引号、前后缀或多个候选标题。';

export interface AutoTitleGenerateInput {
  /** The current meaningful user prompt. */
  prompt: string;
  /** Recent user/assistant conversation used to derive the title. */
  conversationText: string;
  systemPrompt: string;
  maxLength: number;
  signal: AbortSignal;
}

export interface ResolvedTitleModel {
  model: Model<Api>;
  apiKey: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export type AutoTitleGenerator = (
  input: AutoTitleGenerateInput,
  ctx: ExtensionContext,
  resolved: ResolvedTitleModel,
) => Promise<string | undefined>;

interface AutoTitleOptions {
  /** Override the config file path (tests). */
  configPath?: string;
  /** Override the LLM call (tests). Defaults to generateTitleWithModel. */
  generate?: AutoTitleGenerator;
}

/** Resolve the model to use for title generation: configured override first, then the session model. */
export function resolveTitleModel(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  config: AutoTitleSettings,
): Model<Api> | undefined {
  if (config.providerId && config.modelId) {
    return ctx.modelRegistry.find(config.providerId, config.modelId);
  }
  return ctx.model;
}

export async function resolveTitleModelAuth(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  model: Model<Api>,
): Promise<ResolvedTitleModel | undefined> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return undefined;
  return { model, apiKey: auth.apiKey, headers: auth.headers, env: auth.env };
}

function responseText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        !!block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        !!block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

/** Remove known injected command/IDE wrappers and synthetic interruptions. */
export function cleanTitleText(text: string): string | undefined {
  const cleaned = text
    .replace(SYNTHETIC_BLOCK_PATTERN, "")
    .replace(SYNTHETIC_TAG_PATTERN, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!cleaned || /^\[Request interrupted by user\]$/i.test(cleaned)) return undefined;
  return cleaned;
}

/** Build a compact, labeled transcript for title generation. */
export function buildConversationText(entries: readonly SessionEntry[], currentPrompt?: string): string {
  const sections: string[] = [];

  for (const entry of entries) {
    if (entry.type === "message") {
      const message = entry.message;
      if (message.role !== "user" && message.role !== "assistant") continue;
      const text = cleanTitleText(extractTextContent(message.content));
      if (text) sections.push(`${message.role === "user" ? "User" : "Assistant"}: ${text}`);
      continue;
    }

    if (entry.type === "compaction" || entry.type === "branch_summary") {
      const summary = cleanTitleText(entry.summary);
      if (summary) sections.push(`Context summary: ${summary}`);
    }
  }

  const prompt = currentPrompt ? cleanTitleText(currentPrompt) : undefined;
  if (prompt) sections.push(`User: ${prompt}`);

  const conversation = sections.join("\n");
  return conversation.length > MAX_CONVERSATION_TEXT ? conversation.slice(-MAX_CONVERSATION_TEXT) : conversation;
}

function truncateTitle(title: string, maxLength: number): string {
  const limit = Math.max(1, Math.floor(maxLength));
  if (title.length <= limit) return title;
  if (limit === 1) return title.slice(0, 1);
  return `${title.slice(0, limit - 1).trimEnd()}…`;
}

/** Derive a useful local title before the model response arrives. */
export function derivePlaceholderTitle(text: string, maxLength: number): string | undefined {
  const cleaned = cleanTitleText(text);
  if (!cleaned) return undefined;
  const firstSentence = cleaned.match(/^.*?(?:\.(?=\s|$)|[!?。！？](?=\s|$|[^\d]))/)?.[0] ?? cleaned;
  const flat = firstSentence.replace(/\s+/g, " ").trim();
  return flat ? truncateTitle(flat, maxLength) : undefined;
}

function parseStructuredTitle(text: string): { found: boolean; title?: string } {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) candidates.push(fenced);

  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(trimmed.slice(objectStart, objectEnd + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const title = (parsed as { title?: unknown }).title;
      if (typeof title === "string") return { found: true, title };
    } catch {
      // Try the next representation, then fall back to the plain-text contract.
    }
  }

  return { found: false };
}

/** Strip model wrappers, keep one line, remove terminal punctuation, and clamp. */
export function normalizeTitle(text: string, maxLength: number): string | undefined {
  const structured = parseStructuredTitle(text);
  let title = structured.title ?? text;
  if (!structured.found && /[{}]/.test(text)) return undefined;

  title = title
    .trim()
    .replace(/^```(?:json)?\s*|\s*```$/gi, "")
    .replace(/^(?:title|标题)\s*[:：]\s*/i, "")
    .replace(/^["'`「『【*]+|["'`」』】*]+$/g, "")
    .trim()
    .split(/\r?\n/)[0]!
    .replace(/[.!?。！？]+$/g, "")
    .trim();

  if (title.length === 0) return undefined;
  return truncateTitle(title, maxLength);
}

/** Default generator: call the configured/session model via completeSimple. */
export async function generateTitleWithModel(
  input: AutoTitleGenerateInput,
  _ctx: ExtensionContext,
  resolved: ResolvedTitleModel,
): Promise<string | undefined> {
  const controller = new AbortController();
  const abortFromSession = () => controller.abort();
  if (input.signal.aborted) controller.abort();
  else input.signal.addEventListener("abort", abortFromSession, { once: true });
  const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
  const userMessage: Message = {
    role: "user",
    content: [{ type: "text", text: input.conversationText }],
    timestamp: Date.now(),
  };
  try {
    const response = await completeSimple(
      resolved.model,
      { systemPrompt: input.systemPrompt, messages: [userMessage] },
      {
        apiKey: resolved.apiKey,
        headers: resolved.headers,
        env: resolved.env,
        signal: controller.signal,
        maxTokens: 80,
        temperature: 0.2,
        cacheRetention: "none",
      },
    );
    if (response.stopReason === "aborted") return undefined;
    return normalizeTitle(responseText(response.content), input.maxLength);
  } catch (error) {
    if (controller.signal.aborted) return undefined;
    console.warn(`[pi-auto-title] LLM 调用失败: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", abortFromSession);
  }
}

function buildSystemPrompt(config: AutoTitleSettings): string {
  return `${config.systemPrompt}\n\n${TITLE_FORMAT_INSTRUCTIONS}\n长度限制：标题不超过 ${config.maxLength} 个字符。`;
}

export default function piAutoTitle(pi: ExtensionAPI, options: AutoTitleOptions = {}): void {
  let eligible = false;
  let currentSessionId: string | undefined;
  let meaningfulUserMessageCount = 0;
  let autoTitle: string | undefined;
  let provisionalAutoTitle: string | undefined;
  let explicitTitle = false;
  let generationSequence = 0;
  const pendingGenerations = new Set<AbortController>();

  const invalidateGenerations = () => {
    generationSequence += 1;
    for (const controller of pendingGenerations) controller.abort();
    pendingGenerations.clear();
  };

  const markExplicitTitle = () => {
    if (explicitTitle) return;
    explicitTitle = true;
    eligible = false;
    invalidateGenerations();
  };

  const hasExplicitTitle = (): boolean => {
    if (explicitTitle) return true;
    const currentName = pi.getSessionName();
    if (currentName && currentName !== autoTitle) {
      markExplicitTitle();
      return true;
    }
    return false;
  };

  const applyAutoTitle = (title: string, provisional = false): void => {
    autoTitle = title;
    provisionalAutoTitle = provisional ? title : undefined;
    pi.setSessionName(title);
  };

  const clearProvisionalTitle = (generation: number): void => {
    const title = provisionalAutoTitle;
    if (!title || generation !== generationSequence || !eligible || explicitTitle || autoTitle !== title) return;
    const currentName = pi.getSessionName();
    if (currentName && currentName !== title) return;
    autoTitle = undefined;
    provisionalAutoTitle = undefined;
    pi.setSessionName("");
  };

  const scheduleGeneration = (
    prompt: string,
    conversationText: string,
    config: AutoTitleSettings,
    ctx: ExtensionContext,
    provisionalTitle?: string,
  ): void => {
    const sessionId = currentSessionId;
    if (!sessionId || !conversationText) return;

    const controller = new AbortController();
    const generation = ++generationSequence;
    pendingGenerations.add(controller);
    const generate = options.generate ?? generateTitleWithModel;
    const input: AutoTitleGenerateInput = {
      prompt,
      conversationText,
      systemPrompt: buildSystemPrompt(config),
      maxLength: config.maxLength,
      signal: controller.signal,
    };

    // Fire-and-forget: never block, delay, or interrupt the main session.
    void (async () => {
      try {
        const model = resolveTitleModel(ctx, config);
        if (!model || controller.signal.aborted) {
          clearProvisionalTitle(generation);
          return;
        }
        const resolved = await resolveTitleModelAuth(ctx, model);
        if (!resolved || controller.signal.aborted) {
          clearProvisionalTitle(generation);
          return;
        }

        if (
          provisionalTitle &&
          generation === generationSequence &&
          eligible &&
          !hasExplicitTitle() &&
          !pi.getSessionName()
        ) {
          applyAutoTitle(provisionalTitle, true);
        }

        const title = await generate(input, ctx, resolved);
        if (!title || controller.signal.aborted) {
          clearProvisionalTitle(generation);
          return;
        }
        if (generation !== generationSequence || !eligible || currentSessionId !== sessionId) return;
        if (hasExplicitTitle()) return;

        const currentName = pi.getSessionName();
        if (currentName && currentName !== autoTitle) return;
        applyAutoTitle(title);
      } catch (error) {
        clearProvisionalTitle(generation);
        if (!controller.signal.aborted) {
          console.warn(`[pi-auto-title] 标题生成失败: ${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        pendingGenerations.delete(controller);
      }
    })();
  };

  pi.on("session_start", (event, ctx) => {
    invalidateGenerations();
    currentSessionId = ctx.sessionManager.getSessionId();
    meaningfulUserMessageCount = 0;
    autoTitle = undefined;
    provisionalAutoTitle = undefined;
    const existingName = ctx.sessionManager.getSessionName();
    explicitTitle = Boolean(existingName);
    eligible = event.reason === "new" && !explicitTitle;
  });

  pi.on("session_info_changed", (event) => {
    if (eligible && event.name !== autoTitle) markExplicitTitle();
  });

  pi.on("session_shutdown", () => {
    clearProvisionalTitle(generationSequence);
    eligible = false;
    currentSessionId = undefined;
    meaningfulUserMessageCount = 0;
    autoTitle = undefined;
    provisionalAutoTitle = undefined;
    invalidateGenerations();
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!eligible || hasExplicitTitle()) return;

    const prompt = cleanTitleText(event.prompt);
    if (!prompt) return;
    meaningfulUserMessageCount += 1;

    const config = loadAutoTitleConfig(options.configPath);
    if (!config.enabled) return;

    let entries: readonly SessionEntry[] = [];
    try {
      entries = ctx.sessionManager.buildContextEntries();
    } catch {
      // The session may be transitioning; the current prompt still makes a useful title.
    }
    const conversationText = buildConversationText(entries, prompt);
    if (!conversationText) return;

    if (meaningfulUserMessageCount === 1) {
      const placeholder = derivePlaceholderTitle(prompt, config.maxLength);
      scheduleGeneration(prompt, conversationText, config, ctx, placeholder);
    } else if (meaningfulUserMessageCount === TITLE_REFINEMENT_MESSAGE_COUNT) {
      scheduleGeneration(prompt, conversationText, config, ctx);
    }
  });
}
