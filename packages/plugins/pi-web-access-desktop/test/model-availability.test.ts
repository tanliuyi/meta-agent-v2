import assert from "node:assert/strict";
import test from "node:test";
import { type Api, type Model, complete } from "@earendil-works/pi-ai/compat";
import { generateSummaryDraft, type SummaryGenerationContext } from "../vendor/pi-web-access/summary-review.ts";
import type { QueryResultData } from "../vendor/pi-web-access/storage.ts";

const model = {
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  api: "openai-completions",
  provider: "opencode-go",
  baseUrl: "https://opencode.ai/zen/go/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 384_000,
} as Model<Api>;

const results: QueryResultData[] = [{
  query: "test query",
  answer: "test answer",
  results: [],
  error: null,
  provider: "exa",
}];

function createContext(): SummaryGenerationContext {
  const modelRegistry = {
    getAvailable: () => [model],
    find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
    getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }),
  } as unknown as SummaryGenerationContext["modelRegistry"];
  return {
    model: undefined,
    modelRegistry,
  };
}

const fakeComplete = (async () => ({
  stopReason: "stop",
  content: [{ type: "text", text: "summary from configured model" }],
}) as never) as typeof complete;

test("uses an authenticated summary model outside the Pi cycling scope", async () => {
  const generated = await generateSummaryDraft(
    results,
    createContext(),
    undefined,
    "opencode-go/deepseek-v4-flash",
    undefined,
    fakeComplete,
  );

  assert.equal(generated.meta.model, "opencode-go/deepseek-v4-flash");
  assert.equal(generated.summary, "summary from configured model");
});
