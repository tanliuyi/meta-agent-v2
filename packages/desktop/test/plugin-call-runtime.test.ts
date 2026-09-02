import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { DEFAULT_PLUGIN_CALL_LIMITS } from "../src/main/pi/plugin-call/plugin-call-limits.ts";
import { executePluginProgram, PluginCallRunManager } from "../src/main/pi/plugin-call/plugin-call-runtime.ts";
import { PluginMethodDispatcher } from "../src/main/pi/plugin-call/plugin-method-dispatcher.ts";
import { DesktopPluginRegistryBuilder } from "../src/main/pi/plugin-call/plugin-method-registry.ts";
import type { PluginMethodExecutionContext } from "../src/shared/desktop-extension-contracts.ts";

describe("plugin call runtime", () => {
  test("plugin registry validates catalog and executes a program in a fresh worker", async () => {
    const parameters = Type.Object({ value: Type.Number() }, { additionalProperties: false });
    const result = Type.Object({ doubled: Type.Number() }, { additionalProperties: false });
    const entry = {
      id: "development:example",
      displayName: "Example",
      source: "development" as const,
      entryPath: "/tmp/example.ts",
      hostProfileVersion: 1 as const,
      capabilities: ["plugin-methods.provide" as const],
      pluginId: "com.example.math",
      pluginCallSkill: "plugin-example-math",
      pluginCallCatalog: {
        schemaVersion: 1 as const,
        pluginId: "com.example.math",
        methods: [
          {
            name: "double",
            description: "Double a number",
            parameters: parameters as never,
            result: result as never,
            concurrency: "serial" as const,
          },
        ],
      },
    };
    const builder = new DesktopPluginRegistryBuilder();
    builder.stage(entry, {
      schemaVersion: 1,
      methods: [
        {
          name: "double",
          description: "Double a number",
          parameters,
          result,
          async execute(args) {
            return { doubled: args.value * 2 };
          },
        },
      ],
    });
    builder.commit(entry.id);
    const registry = builder.finalize();
    const details = { calls: [], logs: [] };
    const value = await executePluginProgram(
      'const first = await plugin["com.example.math"].double({ value: 21 }); return { doubled: first.doubled };',
      new PluginMethodDispatcher(registry, process.cwd()),
      "tool-1",
      undefined,
      process.cwd(),
      undefined,
      details,
    );
    expect(value).toEqual({ doubled: 42 });
    expect(details.calls).toHaveLength(1);
    expect(details.calls[0].state).toBe("complete");
  });

  test("supports erasable TypeScript and dotted plugin namespaces", async () => {
    const dispatcher = createMathDispatcher();
    await expect(
      executePluginProgram(
        "interface Input { value: number }\nconst input: Input = { value: 5 };\nconst value = await plugin.com.example.math.double(input);\nreturn value;",
        dispatcher,
        "tool-typescript",
        undefined,
        process.cwd(),
      ),
    ).resolves.toEqual({ doubled: 10 });
  });

  test("preserves stable method errors across the worker bridge", async () => {
    await expect(
      executePluginProgram(
        'return await plugin["com.example.math"].missing({ value: 1 });',
        createMathDispatcher(),
        "tool-error",
        undefined,
        process.cwd(),
      ),
    ).rejects.toMatchObject({ code: "PLUGIN_METHOD_NOT_FOUND", pluginId: "com.example.math", method: "missing" });
  });

  test("distinguishes timeout, pre-abort, and invalid outer output", async () => {
    const limits = { ...DEFAULT_PLUGIN_CALL_LIMITS, timeoutMs: 200, computeTimeoutMs: 75 };
    await expect(
      executePluginProgram("while (true) {}", createMathDispatcher(), "tool-timeout", undefined, process.cwd(), limits),
    ).rejects.toMatchObject({ code: "PLUGIN_CALL_TIMEOUT" });

    const controller = new AbortController();
    controller.abort();
    await expect(
      executePluginProgram("return 1", createMathDispatcher(), "tool-abort", controller.signal, process.cwd()),
    ).rejects.toMatchObject({ code: "PLUGIN_CALL_ABORTED" });

    await expect(
      executePluginProgram("return 1n", createMathDispatcher(), "tool-output", undefined, process.cwd()),
    ).rejects.toMatchObject({ code: "PLUGIN_CODE_INVALID_OUTPUT" });
  });

  test("generation disposal aborts and awaits a live worker", async () => {
    const manager = new PluginCallRunManager();
    const execution = executePluginProgram(
      "await new Promise(() => {});",
      createMathDispatcher(),
      "tool-dispose",
      undefined,
      process.cwd(),
      { ...DEFAULT_PLUGIN_CALL_LIMITS, timeoutMs: 5_000 },
      { calls: [], logs: [], attachments: [] },
      manager,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    await manager.dispose();
    await expect(execution).rejects.toMatchObject({ code: "PLUGIN_GENERATION_STALE" });
  });

  test("captures bounded console logs without adding them to the return value", async () => {
    const details = { calls: [], logs: [], attachments: [] };
    await expect(
      executePluginProgram(
        'console.info("private", { value: 1 }); return "visible";',
        createMathDispatcher(),
        "tool-log",
        undefined,
        process.cwd(),
        undefined,
        details,
      ),
    ).resolves.toBe("visible");
    expect(details.logs).toEqual([{ sequence: 1, level: "info", text: 'private {"value":1}' }]);
  });

  test("commits relative file and image attachments only after a valid method result", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-plugin-runtime-"));
    await writeFile(join(cwd, "report.txt"), "report", "utf8");
    const details = { calls: [], logs: [], attachments: [] };
    const dispatcher = createMathDispatcher(async (args, _signal, context) => {
      context.attach({ type: "file", path: "report.txt", name: "report.txt" });
      context.attach({ type: "image", data: "aW1hZ2U=", mimeType: "image/png" });
      return { doubled: args.value * 2 };
    }, cwd);
    await expect(
      executePluginProgram(
        'return await plugin["com.example.math"].double({ value: 3 });',
        dispatcher,
        "tool-attachments",
        undefined,
        cwd,
        undefined,
        details,
      ),
    ).resolves.toEqual({ doubled: 6 });
    expect(details.attachments).toMatchObject([
      { type: "file", name: "report.txt", size: 6 },
      { type: "image", mimeType: "image/png" },
    ]);
    await rm(cwd, { recursive: true, force: true });
  });

  test("tracks supported subprocesses and rejects detached or nested isolates", async () => {
    await expect(
      executePluginProgram(
        `
          const { execFile } = await import("node:child_process");
          const stdout: string = await new Promise((resolve, reject) => {
            execFile(process.execPath, ["-e", "process.stdout.write('ok')"], (error, value) =>
              error ? reject(error) : resolve(value),
            );
          });
          return stdout;
        `,
        createMathDispatcher(),
        "tool-child",
        undefined,
        process.cwd(),
      ),
    ).resolves.toBe("ok");

    await expect(
      executePluginProgram(
        'const { spawn } = await import("node:child_process"); spawn(process.execPath, [], { detached: true });',
        createMathDispatcher(),
        "tool-detached",
        undefined,
        process.cwd(),
      ),
    ).rejects.toMatchObject({ code: "PLUGIN_CODE_EXCEPTION" });

    await expect(
      executePluginProgram(
        'const { Worker } = await import("node:worker_threads"); new Worker("", { eval: true });',
        createMathDispatcher(),
        "tool-nested-worker",
        undefined,
        process.cwd(),
      ),
    ).rejects.toMatchObject({ code: "PLUGIN_CODE_EXCEPTION" });
  });

  test("cleans tracked subprocesses when an outer run times out", async () => {
    const details = { calls: [], logs: [], attachments: [] };
    await expect(
      executePluginProgram(
        `
          const { spawn } = await import("node:child_process");
          const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"]);
          console.log(String(child.pid));
          await new Promise(() => {});
        `,
        createMathDispatcher(),
        "tool-child-timeout",
        undefined,
        process.cwd(),
        { ...DEFAULT_PLUGIN_CALL_LIMITS, timeoutMs: 250, computeTimeoutMs: 2_000 },
        details,
      ),
    ).rejects.toMatchObject({ code: "PLUGIN_CALL_TIMEOUT" });
    const pid = Number(details.logs[0]?.text);
    expect(Number.isSafeInteger(pid)).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("enforces call, progress, and attachment budgets", async () => {
    await expect(
      executePluginProgram(
        `
          await Promise.all(Array.from({ length: 3 }, (_, value) => plugin["com.example.math"].double({ value })));
          return true;
        `,
        createMathDispatcher(),
        "tool-call-limit",
        undefined,
        process.cwd(),
        { ...DEFAULT_PLUGIN_CALL_LIMITS, maxCalls: 2 },
      ),
    ).rejects.toMatchObject({ code: "PLUGIN_CALL_LIMIT_EXCEEDED" });

    const progressDispatcher = createMathDispatcher(async (args, _signal, context) => {
      context.reportProgress({ text: "too large" });
      return { doubled: args.value * 2 };
    });
    await expect(
      executePluginProgram(
        'return plugin["com.example.math"].double({ value: 1 });',
        progressDispatcher,
        "tool-progress-limit",
        undefined,
        process.cwd(),
        { ...DEFAULT_PLUGIN_CALL_LIMITS, maxProgressBytes: 4 },
      ),
    ).rejects.toMatchObject({ code: "PLUGIN_PROGRESS_LIMIT_EXCEEDED" });

    const attachmentDispatcher = createMathDispatcher(async (args, _signal, context) => {
      context.attach({ type: "image", data: "aW1hZ2U=", mimeType: "image/png" });
      return { doubled: args.value * 2 };
    });
    await expect(
      executePluginProgram(
        'return plugin["com.example.math"].double({ value: 1 });',
        attachmentDispatcher,
        "tool-attachment-limit",
        undefined,
        process.cwd(),
        { ...DEFAULT_PLUGIN_CALL_LIMITS, maxImageBytes: 1 },
      ),
    ).rejects.toMatchObject({ code: "PLUGIN_ATTACHMENT_LIMIT_EXCEEDED" });
  });

  test("rejects schemas outside the closed profile", () => {
    const parameters = Type.Object({ value: Type.String({ default: "unsafe" }) }, { additionalProperties: false });
    const builder = new DesktopPluginRegistryBuilder();
    expect(() =>
      builder.stage(
        {
          id: "development:invalid-schema",
          displayName: "Invalid schema",
          source: "development",
          entryPath: "/tmp/invalid-schema.ts",
          hostProfileVersion: 1,
          capabilities: ["plugin-methods.provide"],
          pluginId: "com.example.invalid",
          pluginCallSkill: "plugin-invalid",
          pluginCallCatalog: {
            schemaVersion: 1,
            pluginId: "com.example.invalid",
            methods: [
              {
                name: "run",
                description: "Run invalid schema",
                parameters: parameters as never,
                result: Type.Null() as never,
                concurrency: "serial",
              },
            ],
          },
        },
        {
          schemaVersion: 1,
          methods: [
            {
              name: "run",
              description: "Run invalid schema",
              parameters,
              result: Type.Null(),
              async execute() {
                return null;
              },
            },
          ],
        },
      ),
    ).toThrow("PLUGIN_SCHEMA_INVALID");
  });

  test("plugin dispatcher rejects invalid arguments", async () => {
    const parameters = Type.Object({ value: Type.Number() }, { additionalProperties: false });
    const builder = new DesktopPluginRegistryBuilder();
    builder.stage(
      {
        id: "development:math",
        displayName: "Math",
        source: "development",
        entryPath: "/tmp/math.ts",
        hostProfileVersion: 1,
        capabilities: ["plugin-methods.provide"],
        pluginId: "math",
        pluginCallSkill: "plugin-math",
        pluginCallCatalog: {
          schemaVersion: 1,
          pluginId: "math",
          methods: [
            {
              name: "double",
              description: "Double",
              parameters: parameters as never,
              result: Type.Number() as never,
              concurrency: "serial",
            },
          ],
        },
      },
      {
        schemaVersion: 1,
        methods: [
          {
            name: "double",
            description: "Double",
            parameters,
            result: Type.Number(),
            async execute() {
              return 1;
            },
          },
        ],
      },
    );
    builder.commit("development:math");
    const dispatcher = new PluginMethodDispatcher(builder.finalize(), process.cwd());
    await expect(
      dispatcher.call("math", "double", { value: "bad" }, new AbortController().signal, "tool", {
        calls: [],
        logs: [],
      }),
    ).rejects.toThrow("PLUGIN_METHOD_INVALID_ARGUMENTS");
  });
});

type MathExecute = (
  args: { value: number },
  signal: AbortSignal,
  context: PluginMethodExecutionContext,
) => Promise<{ doubled: number }>;

function createMathDispatcher(
  execute: MathExecute = async (args) => ({ doubled: args.value * 2 }),
  cwd = process.cwd(),
): PluginMethodDispatcher {
  const parameters = Type.Object({ value: Type.Number() }, { additionalProperties: false });
  const result = Type.Object({ doubled: Type.Number() }, { additionalProperties: false });
  const entry = {
    id: "development:math-helper",
    displayName: "Math helper",
    source: "development" as const,
    entryPath: "/tmp/math-helper.ts",
    hostProfileVersion: 1 as const,
    capabilities: ["plugin-methods.provide" as const],
    pluginId: "com.example.math",
    pluginCallSkill: "plugin-math-helper",
    pluginCallCatalog: {
      schemaVersion: 1 as const,
      pluginId: "com.example.math",
      methods: [
        {
          name: "double",
          description: "Double a number",
          parameters: parameters as never,
          result: result as never,
          concurrency: "serial" as const,
        },
      ],
    },
  };
  const builder = new DesktopPluginRegistryBuilder();
  builder.stage(entry, {
    schemaVersion: 1,
    methods: [
      {
        name: "double",
        description: "Double a number",
        parameters,
        result,
        async execute(args: { value: number }, signal: AbortSignal, context: PluginMethodExecutionContext) {
          return execute(args, signal, context);
        },
      },
    ],
  });
  builder.commit(entry.id);
  return new PluginMethodDispatcher(builder.finalize(), cwd);
}
