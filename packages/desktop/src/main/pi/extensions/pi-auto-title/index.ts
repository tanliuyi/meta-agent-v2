/**
 * pi-auto-title: automatic LLM-generated session titles for the Desktop app.
 *
 * When a user creates a new session and sends the first prompt, this extension
 * asynchronously asks an LLM to summarize the prompt into a short title and
 * applies it with `pi.setSessionName()`. Generation is fire-and-forget: it
 * never blocks, delays, or interrupts the main agent turn.
 *
 * The title model and system prompt are configurable from the Desktop settings
 * UI (see AutoTitleSettingsService); the extension reads the same JSON file.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple, type Message } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutoTitleSettings } from "../../../../shared/auto-title-contracts.ts";
import { loadAutoTitleConfig } from "./config.ts";

const TITLE_TIMEOUT_MS = 20_000;

export interface AutoTitleGenerateInput {
  prompt: string;
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
        !!block && typeof block === "object" && (block as { type?: string }).type === "text",
    )
    .map((block) => block.text)
    .join("\n");
}

/** Strip quotes, take the first line, and clamp to maxLength. */
export function normalizeTitle(text: string, maxLength: number): string | undefined {
  let title = text
    .trim()
    .replace(/^["'`「『【]+|["'`」』】]+$/g, "")
    .trim();
  const firstLine = title.split(/\r?\n/)[0];
  if (firstLine !== undefined) title = firstLine.trim();
  if (title.length === 0) return undefined;
  return title.slice(0, maxLength);
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
    content: [{ type: "text", text: input.prompt }],
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
  return `${config.systemPrompt}\n\n长度限制：标题不超过 ${config.maxLength} 个字符。`;
}

export default function piAutoTitle(pi: ExtensionAPI, options: AutoTitleOptions = {}): void {
  // Only arm for brand-new sessions; resumed/forked/reloaded sessions already
  // have content or a name and must not be re-titled.
  let armed = false;
  let activeGeneration: AbortController | undefined;

  pi.on("session_start", (event, _ctx) => {
    activeGeneration?.abort();
    activeGeneration = undefined;
    armed = event.reason === "new";
  });

  pi.on("session_shutdown", () => {
    armed = false;
    activeGeneration?.abort();
    activeGeneration = undefined;
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!armed) return;
    armed = false;

    const prompt = (event as { prompt?: string }).prompt?.trim();
    if (!prompt) return;
    if (pi.getSessionName()) return;

    const sessionId = ctx.sessionManager.getSessionId();
    const config = loadAutoTitleConfig(options.configPath);
    if (!config.enabled) return;

    const generate = options.generate ?? generateTitleWithModel;
    const controller = new AbortController();
    activeGeneration = controller;
    const input: AutoTitleGenerateInput = {
      prompt,
      systemPrompt: buildSystemPrompt(config),
      maxLength: config.maxLength,
      signal: controller.signal,
    };

    // Fire-and-forget: never block, delay, or interrupt the main session.
    void (async () => {
      try {
        const model = resolveTitleModel(ctx, config);
        if (!model || controller.signal.aborted) return;
        const resolved = await resolveTitleModelAuth(ctx, model);
        if (!resolved || controller.signal.aborted) return;

        const title = await generate(input, ctx, resolved);
        if (!title || controller.signal.aborted) return;

        // If the session was replaced while generating, applying the title to
        // the stale binding would throw; treat that as a benign skip.
        try {
          if (ctx.sessionManager.getSessionId() !== sessionId) return;
        } catch {
          return;
        }
        if (pi.getSessionName()) return;
        pi.setSessionName(title);
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn(`[pi-auto-title] 标题生成失败: ${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        if (activeGeneration === controller) activeGeneration = undefined;
      }
    })();
  });
}
