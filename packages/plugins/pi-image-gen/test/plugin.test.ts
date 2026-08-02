import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import imageGenPlugin from "../index.ts";
import { createImageGenSettings, resolveModel } from "../src/config.ts";
import {
  IMAGE_GEN_CONFIGURATION_SCHEMA,
  IMAGE_GEN_CONFIGURATION_SCHEMA_JSON,
} from "../src/configuration.ts";
import { generateImage } from "../src/generate.ts";
import { readImageResponse, resolveImageInputs } from "../src/image-input.ts";
import { BUILT_IN_MODELS } from "../src/models.ts";
import type { BuiltInProviderId, ImageGenSettings } from "../src/types.ts";

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000115c46f250000000049454e44ae426082",
  "hex",
);
const PNG_BASE64 = PNG_BYTES.toString("base64");
const tempDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("configuration", () => {
  it("defaults to exact gpt-image-2 without an image2 alias", () => {
    const settings = createImageGenSettings({});
    expect(settings.defaultModel).toBe("gpt-image-2");
    expect(resolveModel("gpt-image-2", settings)).not.toHaveProperty("error");
    expect(resolveModel("image2", settings)).toHaveProperty("error");
  });

  it("accepts host configuration and falls back to provider environment variables", () => {
    vi.stubEnv("GEMINI_API_KEY", "gemini-env-key");
    const settings = createImageGenSettings({
      defaultModel: "nano-banana-2",
      openaiApiKey: "openai-host-key",
    });
    const openai = resolveModel("gpt-image-2", settings);
    const gemini = resolveModel("nano-banana-2", settings);
    if ("error" in openai || "error" in gemini) throw new Error("Expected models to resolve");
    expect(openai.provider.apiKey).toBe("openai-host-key");
    expect(gemini.provider.apiKey).toBe("gemini-env-key");
  });
});

describe("configuration schema", () => {
  it("declares every field the runtime consumes and no unknown ones", () => {
    const expected = new Set([
      "defaultModel",
      "customModel",
      "outputDir",
      "openaiApiKey",
      "openaiBaseUrl",
      "geminiApiKey",
      "geminiBaseUrl",
      "dashscopeApiKey",
      "dashscopeBaseUrl",
      "arkApiKey",
      "arkBaseUrl",
      "openrouterApiKey",
      "openrouterBaseUrl",
    ]);
    const keys = IMAGE_GEN_CONFIGURATION_SCHEMA.fields.map((field) => field.key);
    expect(new Set(keys)).toEqual(expected);
  });

  it("declares defaults that match runtime behavior", () => {
    const settings = createImageGenSettings({});
    const defaultModel = IMAGE_GEN_CONFIGURATION_SCHEMA.fields.find((field) => field.key === "defaultModel");
    if (defaultModel?.type !== "select") throw new Error("defaultModel field is missing");
    expect(defaultModel).toMatchObject({ required: true, defaultValue: "gpt-image-2" });
    expect(defaultModel.options).toHaveLength(BUILT_IN_MODELS.length + 1);
    expect(defaultModel.options.at(-1)).toEqual({ value: "custom", label: "自定义模型…" });
    for (const option of defaultModel.options.slice(0, -1)) {
      expect(option.description).toBeTruthy();
    }
    expect(settings.defaultModel).toBe(defaultModel.defaultValue);
    const customModel = IMAGE_GEN_CONFIGURATION_SCHEMA.fields.find((field) => field.key === "customModel");
    if (customModel?.type !== "text") throw new Error("customModel field is missing");
    expect(customModel.placeholder).toBe("openrouter/<厂商>/<模型>");
    const outputDir = IMAGE_GEN_CONFIGURATION_SCHEMA.fields.find((field) => field.key === "outputDir");
    if (outputDir?.type !== "path") throw new Error("outputDir field is missing");
    expect(outputDir).toMatchObject({ defaultValue: ".pi/images" });
    expect(createImageGenSettings({ outputDir: outputDir.defaultValue })).toMatchObject({
      outputDir: ".pi/images",
    });
  });

  it("prefers a custom model only when the built-in select is set to custom", () => {
    expect(createImageGenSettings({ defaultModel: "custom" })).toMatchObject({ defaultModel: "gpt-image-2" });
    expect(createImageGenSettings({ defaultModel: "custom", customModel: "openrouter/deepseek/deepseek-chat" })).toMatchObject(
      { defaultModel: "openrouter/deepseek/deepseek-chat" },
    );
    expect(createImageGenSettings({ defaultModel: "gemini-3-pro-image", customModel: "nano-banana" })).toMatchObject(
      { defaultModel: "gemini-3-pro-image" },
    );
  });

  it("keeps secret fields free of defaults and validates base URLs with a pattern", () => {
    for (const field of IMAGE_GEN_CONFIGURATION_SCHEMA.fields) {
      if (field.type !== "secret") continue;
      expect("defaultValue" in field).toBe(false);
      expect(field.key.endsWith("ApiKey")).toBe(true);
    }
    for (const field of IMAGE_GEN_CONFIGURATION_SCHEMA.fields) {
      if (field.type !== "text" || !field.key.endsWith("BaseUrl")) continue;
      expect(field.pattern).toBe("^https?://");
      expect(field.patternMessage).toBe("必须以 http:// 或 https:// 开头");
      expect(() => new RegExp(field.pattern!)).not.toThrow();
    }
  });

  it("round-trips through the JSON form used when publishing", () => {
    expect(JSON.parse(IMAGE_GEN_CONFIGURATION_SCHEMA_JSON)).toEqual(IMAGE_GEN_CONFIGURATION_SCHEMA);
  });

  it("orders provider groups after the common configuration fields", () => {
    const orders = IMAGE_GEN_CONFIGURATION_SCHEMA.fields.map((field) => field.order);
    expect(orders).toEqual([...orders].sort((left, right) => (left ?? 0) - (right ?? 0)));
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("matches the market-manifest.json used by Desktop Developer Mode", async () => {
    const manifest = JSON.parse(await readFile(join(import.meta.dirname, "..", "market-manifest.json"), "utf8"));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.desktop.hostProfileVersion).toBe(1);
    expect(manifest.pi.entry).toBe("index.ts");
    expect(manifest.capabilities).toContain("configuration.read");
    expect(manifest.configuration).toEqual(IMAGE_GEN_CONFIGURATION_SCHEMA);
  });
});

describe("provider adapters", () => {
  const cases: Array<{
    provider: BuiltInProviderId;
    model: string;
    expectedPath: string;
    response: unknown;
    verifyBody?: (body: Record<string, unknown>) => void;
  }> = [
    {
      provider: "openai",
      model: "gpt-image-2",
      expectedPath: "/v1/images/generations",
      response: { data: [{ b64_json: PNG_BASE64 }] },
    },
    {
      provider: "gemini",
      model: "gemini-3.1-flash-image",
      expectedPath: "/v1beta/models/gemini-3.1-flash-image:generateContent",
      response: {
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG_BASE64 } }] } }],
      },
    },
    {
      provider: "dashscope",
      model: "qwen-image-2.0",
      expectedPath: "/api/v1/services/aigc/multimodal-generation/generation",
      response: {
        output: {
          choices: [{ message: { content: [{ image: `data:image/png;base64,${PNG_BASE64}` }] } }],
        },
      },
      verifyBody: (body) => {
        const parameters = body.parameters as Record<string, unknown>;
        expect(parameters.n).toBe(6);
        expect(parameters.size).toBe("1328*1328");
      },
    },
    {
      provider: "ark",
      model: "seedream-5",
      expectedPath: "/api/v3/images/generations",
      response: { data: [{ b64_json: PNG_BASE64 }] },
      verifyBody: (body) => {
        expect(body).not.toHaveProperty("n");
        expect(body.sequential_image_generation).toBe("auto");
        expect(body.sequential_image_generation_options).toEqual({ max_images: 3 });
      },
    },
    {
      provider: "openrouter",
      model: "openrouter/openai/gpt-image-2",
      expectedPath: "/api/v1/images",
      response: { data: [{ b64_json: PNG_BASE64 }] },
    },
  ];

  it.each(cases)("generates through $provider without a real provider call", async (testCase) => {
    const cwd = await mkdtemp(join(tmpdir(), `desktop-image-${testCase.provider}-`));
    tempDirectories.push(cwd);
    const seenUrls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      seenUrls.push(String(input));
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      testCase.verifyBody?.(body);
      return new Response(JSON.stringify(testCase.response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const settings: ImageGenSettings = {
      defaultModel: testCase.model,
      providers: { [testCase.provider]: { apiKey: "test-key" } },
    };

    const result = await generateImage(
      {
        prompt: "deterministic fixture",
        filename: testCase.provider,
        n: testCase.provider === "dashscope" ? 6 : testCase.provider === "ark" ? 3 : 1,
        size: testCase.provider === "dashscope" ? "1328x1328" : undefined,
      },
      { cwd, settings, fetchImpl },
    );

    expect(new URL(seenUrls[0] ?? "https://invalid.test").pathname).toBe(testCase.expectedPath);
    expect(result.images).toHaveLength(1);
    expect(await readFile(result.images[0]!.path)).toEqual(PNG_BYTES);
  });
});

describe("extension contract", () => {
  it("registers one Desktop-compatible tool and throws on execution failure", async () => {
    let registeredTool:
      | { name: string; execute: (...args: unknown[]) => Promise<unknown> }
      | undefined;
    const commands: string[] = [];
    const mockApi = {
      getConfig: () => ({ openaiApiKey: "bad-key" }),
      on: vi.fn(),
      registerTool: (tool: unknown) => {
        registeredTool = tool as { name: string; execute: (...args: unknown[]) => Promise<unknown> };
      },
      registerCommand: (name: string) => commands.push(name),
    } as unknown as ExtensionAPI;
    imageGenPlugin(mockApi);

    expect(registeredTool?.name).toBe("image_generate");
    expect(commands).toEqual(["image-gen"]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })) as unknown as typeof fetch,
    );
    const cwd = await mkdtemp(join(tmpdir(), "desktop-image-extension-"));
    tempDirectories.push(cwd);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(
        registeredTool?.execute(
          "call-1",
          { prompt: "fixture" },
          undefined,
          undefined,
          { cwd },
        ),
      ).rejects.toThrow(/rejected the API key/i);
      expect(errorSpy.mock.calls.flat().join(" ")).not.toContain("bad-key");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects local reference files outside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "desktop-image-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "desktop-image-outside-"));
    tempDirectories.push(workspace, outside);
    const outsideImage = join(outside, "outside.png");
    await writeFile(outsideImage, PNG_BYTES);

    await expect(resolveImageInputs([outsideImage], workspace, fetch)).rejects.toThrow(
      /inside the current workspace/i,
    );
  });

  it("rejects private image URLs before making a request", async () => {
    const fetchImpl = vi.fn(async () => new Response(PNG_BYTES)) as unknown as typeof fetch;
    await expect(
      resolveImageInputs(["http://127.0.0.1/private.png"], process.cwd(), fetchImpl),
    ).rejects.toThrow(/public host/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects non-image local files", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "desktop-image-format-"));
    tempDirectories.push(workspace);
    await writeFile(join(workspace, "not-image.png"), "not an image");
    await expect(
      resolveImageInputs(["not-image.png"], workspace, fetch),
    ).rejects.toThrow(/supported PNG/i);
  });

  it("rejects oversized remote images before reading the body", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-length": String(25 * 1024 * 1024 + 1) } },
    );
    await expect(readImageResponse(response, "Image input", "https://example.test/image")).rejects.toThrow(
      /25 MB/,
    );
    expect(cancelled).toBe(true);
  });
});
