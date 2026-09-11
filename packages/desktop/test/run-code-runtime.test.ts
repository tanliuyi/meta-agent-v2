import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { PluginMethodDispatcher } from "../src/main/pi/run-code/plugin-method-dispatcher.ts";
import {
  DesktopPluginRegistryBuilder,
  type RegisteredDesktopPluginMethod,
  validatePluginSchemaProfile,
} from "../src/main/pi/run-code/plugin-method-registry.ts";
import { normalizePluginError } from "../src/main/pi/run-code/run-code-errors.ts";
import { DEFAULT_RUN_CODE_LIMITS } from "../src/main/pi/run-code/run-code-limits.ts";
import { executePluginProgram, RunCodeRunManager } from "../src/main/pi/run-code/run-code-runtime.ts";
import { RunCodeRegistryHolder } from "../src/main/pi/run-code/run-code-tool.ts";
import type { PluginMethodExecutionContext } from "../src/shared/desktop-extension-contracts.ts";

describe("run_code runtime", () => {
  test("rejects a plugin generation that captures no methods", () => {
    expect(() => new DesktopPluginRegistryBuilder().commit("empty-plugin")).toThrow("PLUGIN_DECLARATION_INVALID");
  });

  test("generates plugin metadata from captured tools without a catalog or skill", async () => {
    const parameters = Type.Object({}, { additionalProperties: false });
    const entry = {
      id: "development:generated",
      displayName: "Generated",
      source: "development" as const,
      hostProfileVersion: 1 as const,
      capabilities: ["plugin-methods.provide" as const],
      pluginId: "com.example.generated",
    };
    const builder = new DesktopPluginRegistryBuilder();
    for (const name of ["active", "optional"]) {
      builder.stageTool(entry, {
        name,
        label: name,
        description: `${name} method`,
        parameters,
        async execute() {
          return { content: [{ type: "text" as const, text: "ok" }] };
        },
      });
    }
    builder.commit(entry.id);
    const registry = builder.finalize();
    expect([...registry.get(entry.pluginId)!.keys()]).toEqual(["active", "optional"]);

    const holder = new RunCodeRegistryHolder("generated-catalog");
    holder.bind(registry, "/tmp");
    const generated = holder.generatedApiInstructions();
    expect(generated).toContain('readonly "com.example.generated": {');
    expect(generated).toContain('readonly "active": (args: Record<string, never>)');
    expect(generated).toContain('Promise<{\n      readonly "text": string;');
    expect(generated).toContain("declare class PluginCallError extends Error");
    expect(generated).not.toContain('"pluginId":"com.example.generated"');
    await holder.dispose();
  });

  test("rejects generated API context that exceeds the aggregate prompt budget", () => {
    const parameters = Type.Object({}, { additionalProperties: false });
    const builder = new DesktopPluginRegistryBuilder();
    for (let index = 0; index < 64; index++) {
      const entry = {
        id: `development:generated-${index}`,
        displayName: `Generated ${index}`,
        source: "development" as const,
        hostProfileVersion: 1 as const,
        capabilities: ["plugin-methods.provide" as const],
        pluginId: `com.example.generated${index}`,
      };
      builder.stageTool(entry, {
        name: "run",
        label: "Run",
        description: "D".repeat(4_096),
        parameters,
        async execute() {
          return { content: [{ type: "text" as const, text: "ok" }] };
        },
      });
      builder.commit(entry.id);
    }

    expect(() => builder.finalize()).toThrow("PLUGIN_GENERATED_CONTEXT_TOO_LARGE");
  });

  test("clears committed methods before a new capture batch", () => {
    const parameters = Type.Object({}, { additionalProperties: false });
    const entry = {
      id: "development:reloadable",
      pluginId: "com.example.reloadable",
      displayName: "Reloadable",
      source: "development" as const,
      entryPath: "/tmp/reloadable.ts",
      hostProfileVersion: 1 as const,
      capabilities: ["plugin-methods.provide" as const],
      runCodeSkill: "reloadable",
      runCodeCatalog: {
        schemaVersion: 1 as const,
        pluginId: "com.example.reloadable",
        methods: [
          {
            name: "run",
            description: "Run",
            parameters,
            result: Type.Object({ text: Type.String() }, { additionalProperties: false }),
            concurrency: "serial" as const,
          },
        ],
      },
    };
    const builder = new DesktopPluginRegistryBuilder();
    builder.stageTool(entry, {
      name: "run",
      label: "Run",
      description: "Run",
      parameters,
      async execute() {
        return { content: [{ type: "text", text: "old" }] };
      },
    });
    builder.commit(entry.id);
    expect(builder.finalize().get(entry.pluginId)).toBeDefined();

    builder.clear();

    expect(builder.finalize()).toEqual(new Map());
  });

  test("normalizes unknown plugin error codes to the supplied fallback", () => {
    const normalized = normalizePluginError(
      Object.assign(new Error("unexpected"), { code: "PLUGIN_UNKNOWN" }),
      "PLUGIN_CODE_EXCEPTION",
    );
    expect(normalized.code).toBe("PLUGIN_CODE_EXCEPTION");
    expect(normalized.message).toBe("unexpected");
  });

  test("plugin registry validates catalog and executes a program in a fresh worker", async () => {
    const description = "D".repeat(655);
    const parameters = Type.Object({ value: Type.Number() }, { additionalProperties: false });
    const result = Type.Object({ text: Type.String() }, { additionalProperties: false });
    const entry = {
      id: "development:example",
      displayName: "Example",
      source: "development" as const,
      entryPath: "/tmp/example.ts",
      hostProfileVersion: 1 as const,
      capabilities: ["plugin-methods.provide" as const],
      pluginId: "com.example.math",
      runCodeSkill: "plugin-example-math",
      runCodeCatalog: {
        schemaVersion: 1 as const,
        pluginId: "com.example.math",
        methods: [
          {
            name: "double",
            description,
            parameters: parameters as never,
            result: result as never,
            concurrency: "serial" as const,
          },
        ],
      },
    };
    const builder = new DesktopPluginRegistryBuilder();
    builder.stageTool(entry, {
      name: "double",
      label: "Double",
      description,
      parameters,
      async execute(_id, args) {
        return { content: [{ type: "text", text: String(args.value * 2) }] };
      },
    });
    builder.commit(entry.id);
    const registry = builder.finalize();
    const details = { calls: [], logs: [], toolContext: { cwd: process.cwd() } };
    const value = await executePluginProgram(
      'const first = await plugin["com.example.math"].double({ value: 21 }); return { doubled: Number(first.text) };',
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

  test("captures standard Pi tools with their execution context and adapters", async () => {
    const parameters = Type.Object({ value: Type.Number() }, { additionalProperties: false });
    const entry = {
      id: "development:captured",
      displayName: "Captured",
      source: "development" as const,
      entryPath: "/tmp/captured.ts",
      hostProfileVersion: 1 as const,
      capabilities: ["plugin-methods.provide" as const],
      pluginId: "pi.web-access",
      runCodeSkill: "plugin-captured",
      runCodeCatalog: {
        schemaVersion: 1 as const,
        pluginId: "pi.web-access",
        methods: [
          {
            name: "run",
            description: "Run captured tool",
            parameters: parameters as never,
            result: Type.Object({ text: Type.String() }, { additionalProperties: false }) as never,
            concurrency: "serial" as const,
          },
        ],
      },
    };
    const extensionContext = { cwd: process.cwd() };
    const builder = new DesktopPluginRegistryBuilder();
    builder.stageTool(entry, {
      name: "run",
      label: "Run",
      description: "Run captured tool",
      parameters,
      executionMode: "sequential",
      prepareArguments(args) {
        const input = args as { raw: number };
        return { value: input.raw * 2 };
      },
      async execute(_id, params, signal, onUpdate, context) {
        expect(context).toBe(extensionContext);
        expect(signal?.aborted).toBe(false);
        onUpdate?.({ content: [{ type: "text", text: "working" }], details: {} });
        return {
          content: [
            { type: "text", text: `value:${params.value}` },
            { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
          ],
          details: {
            private: true,
            sources: [
              { title: "Assistant UI Sources", url: "https://www.assistant-ui.com/elements/sources" },
              { title: "Duplicate", url: "https://www.assistant-ui.com/elements/sources" },
              { title: "Invalid", url: "javascript:alert(1)" },
            ],
          },
        };
      },
    });
    builder.commit(entry.id);
    const details = { calls: [], logs: [], attachments: [], toolContext: extensionContext };
    await expect(
      executePluginProgram(
        'return plugin["pi.web-access"].run({ raw: 21 });',
        new PluginMethodDispatcher(builder.finalize(), process.cwd()),
        "tool-captured",
        undefined,
        process.cwd(),
        undefined,
        details,
      ),
    ).resolves.toEqual({ text: "value:42\n[image attachment]" });
    expect(details.calls[0]).toMatchObject({
      state: "complete",
      progress: { text: "working" },
      sources: [{ title: "Assistant UI Sources", url: "https://www.assistant-ui.com/elements/sources" }],
    });
    expect(details.attachments).toMatchObject([{ type: "image", mimeType: "image/png" }]);
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

  test("exposes stable PluginCallError values for unknown plugins", async () => {
    await expect(
      executePluginProgram(
        `
          try {
            await plugin["com.example.unknown"].missing({});
          } catch (error) {
            return {
              instanceOf: error instanceof PluginCallError,
              name: error.name,
              code: error.code,
              pluginId: error.pluginId,
              method: error.method,
            };
          }
        `,
        createMathDispatcher(),
        "tool-unknown-plugin",
        undefined,
        process.cwd(),
      ),
    ).resolves.toEqual({
      instanceOf: true,
      name: "PluginCallError",
      code: "PLUGIN_NOT_FOUND",
      pluginId: "com.example.unknown",
      method: "missing",
    });
  });

  test("commits parallel responses and attachments in submission order", async () => {
    const details = { calls: [], logs: [], attachments: [] };
    const dispatcher = createMathDispatcher(
      async (args, _signal, context) => {
        await new Promise((resolve) => setTimeout(resolve, args.value === 1 ? 40 : 5));
        context.attach({
          type: "image",
          data: Buffer.from(String(args.value)).toString("base64"),
          mimeType: "image/png",
          name: `${args.value}.png`,
        });
        return { doubled: args.value * 2 };
      },
      process.cwd(),
      "parallel",
    );
    const result = await executePluginProgram(
      `
        const settled = await Promise.allSettled([
          plugin["com.example.math"].double({ value: 1 }),
          plugin["com.example.math"].double({ value: 1000 }),
        ]);
        return settled.map((item) => item.status === "fulfilled" ? "ok" : item.reason.code);
      `,
      dispatcher,
      "tool-ordered-commit",
      undefined,
      process.cwd(),
      { ...DEFAULT_RUN_CODE_LIMITS, maxCumulativeResponseBytes: 16 },
      details,
    );

    expect(result).toEqual(["ok", "PLUGIN_RESPONSE_LIMIT_EXCEEDED"]);
    expect(details.calls.map((call) => call.state)).toEqual(["complete", "error"]);
    expect(details.attachments).toMatchObject([{ type: "image", name: "1.png" }]);
  });

  test("aborts queued serial calls and poisons a lane whose active method ignores cancellation", async () => {
    const invoked: number[] = [];
    const dispatcher = createMathDispatcher(async (args) => {
      invoked.push(args.value);
      if (args.value === 1) return new Promise(() => {});
      return { doubled: args.value * 2 };
    });
    const details = { calls: [], logs: [], attachments: [] };

    await expect(
      executePluginProgram(
        `
          void plugin["com.example.math"].double({ value: 1 });
          void plugin["com.example.math"].double({ value: 2 });
          await new Promise((resolve) => setTimeout(resolve, 25));
          return "done";
        `,
        dispatcher,
        "tool-serial-abort",
        undefined,
        process.cwd(),
        undefined,
        details,
      ),
    ).resolves.toBe("done");
    expect(invoked).toEqual([1]);
    expect(details.calls.map((call) => call.state)).toEqual(["aborted", "aborted"]);

    await new Promise((resolve) => setTimeout(resolve, 375));
    await expect(
      executePluginProgram(
        'return plugin["com.example.math"].double({ value: 3 });',
        dispatcher,
        "tool-poisoned-lane",
        undefined,
        process.cwd(),
      ),
    ).rejects.toMatchObject({ code: "PLUGIN_GENERATION_STALE" });
    expect(invoked).toEqual([1]);
  });

  test("poisons generation admission when a parallel method ignores cancellation", async () => {
    const invoked: number[] = [];
    const dispatcher = createMathDispatcher(
      async (args) => {
        invoked.push(args.value);
        return new Promise(() => {});
      },
      process.cwd(),
      "parallel",
    );

    await expect(
      executePluginProgram(
        'void plugin["com.example.math"].double({ value: 1 }); return "done";',
        dispatcher,
        "tool-parallel-abort",
        undefined,
        process.cwd(),
      ),
    ).resolves.toBe("done");
    await expect(
      executePluginProgram(
        'return plugin["com.example.math"].double({ value: 2 });',
        dispatcher,
        "tool-poisoned-admission",
        undefined,
        process.cwd(),
      ),
    ).rejects.toMatchObject({ code: "PLUGIN_GENERATION_STALE" });
    expect(invoked).toEqual([1]);
  });

  test("ignores method settlement and updates after the outer run settles", async () => {
    const dispatcher = createMathDispatcher(async (args) => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      return { doubled: args.value * 2 };
    });
    const details = { calls: [], logs: [], attachments: [] };
    let updateCount = 0;

    await expect(
      executePluginProgram(
        'void plugin["com.example.math"].double({ value: 4 }); return "done";',
        dispatcher,
        "tool-late-settlement",
        undefined,
        process.cwd(),
        undefined,
        details,
        undefined,
        () => {
          updateCount += 1;
        },
      ),
    ).resolves.toBe("done");
    const settledDetails = JSON.stringify(details);
    const settledUpdateCount = updateCount;

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(JSON.stringify(details)).toBe(settledDetails);
    expect(updateCount).toBe(settledUpdateCount);
  });

  test("distinguishes timeout, pre-abort, and invalid outer output", async () => {
    const limits = { ...DEFAULT_RUN_CODE_LIMITS, timeoutMs: 200, computeTimeoutMs: 75 };
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
    const manager = new RunCodeRunManager();
    const execution = executePluginProgram(
      "await new Promise(() => {});",
      createMathDispatcher(),
      "tool-dispose",
      undefined,
      process.cwd(),
      { ...DEFAULT_RUN_CODE_LIMITS, timeoutMs: 5_000 },
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
        { ...DEFAULT_RUN_CODE_LIMITS, timeoutMs: 250, computeTimeoutMs: 2_000 },
        details,
      ),
    ).rejects.toMatchObject({ code: "PLUGIN_CALL_TIMEOUT" });
    const pid = Number(details.logs[0]?.text);
    expect(Number.isSafeInteger(pid)).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("cleans tracked subprocesses when generated code blocks the worker event loop", async () => {
    const details = { calls: [], logs: [], attachments: [] };
    await expect(
      executePluginProgram(
        `
          const { spawn } = await import("node:child_process");
          const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"]);
          console.log(String(child.pid));
          while (true) {}
        `,
        createMathDispatcher(),
        "tool-blocked-child-timeout",
        undefined,
        process.cwd(),
        { ...DEFAULT_RUN_CODE_LIMITS, timeoutMs: 250, computeTimeoutMs: 2_000 },
        details,
      ),
    ).rejects.toMatchObject({ code: "PLUGIN_CALL_TIMEOUT" });
    const pid = Number(details.logs[0]?.text);
    expect(Number.isSafeInteger(pid)).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("aborts and settles in-flight plugin methods before returning", async () => {
    let aborted = false;
    const dispatcher = createMathDispatcher(
      (_args, signal) =>
        new Promise<{ doubled: number }>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    );
    await expect(
      executePluginProgram(
        'void plugin["com.example.math"].double({ value: 1 }); await new Promise((resolve) => setTimeout(resolve, 50)); return "done";',
        dispatcher,
        "tool-in-flight",
        undefined,
        process.cwd(),
      ),
    ).resolves.toBe("done");
    expect(aborted).toBe(true);
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
        { ...DEFAULT_RUN_CODE_LIMITS, maxCalls: 2 },
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
        { ...DEFAULT_RUN_CODE_LIMITS, maxProgressBytes: 4 },
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
        { ...DEFAULT_RUN_CODE_LIMITS, maxImageBytes: 1 },
      ),
    ).rejects.toMatchObject({ code: "PLUGIN_ATTACHMENT_LIMIT_EXCEEDED" });
  });

  test("rejects enum and deprecated annotations", () => {
    const parameters = Type.Object(
      {
        mode: Type.String({ enum: ["fast", "safe"], deprecated: true }),
      },
      { additionalProperties: false },
    );
    expect(() => validatePluginSchemaProfile(parameters, true)).toThrow("PLUGIN_SCHEMA_INVALID");
  });

  test("rejects record, unknown, and dynamic object schemas", () => {
    expect(() => validatePluginSchemaProfile(Type.Record(Type.String(), Type.Unknown()), false)).toThrow(
      "PLUGIN_SCHEMA_INVALID",
    );
    expect(() =>
      validatePluginSchemaProfile(
        Type.Object(
          { schema: Type.Unsafe({ type: "object", additionalProperties: true }) },
          { additionalProperties: false },
        ),
        true,
      ),
    ).toThrow("PLUGIN_SCHEMA_INVALID");
  });

  test("rejects schemas outside the closed profile", () => {
    const parameters = Type.Object(
      { value: Type.Unsafe({ $ref: "#/definitions/unsafe" }) },
      { additionalProperties: false },
    );
    const builder = new DesktopPluginRegistryBuilder();
    expect(() =>
      builder.stageTool(
        {
          id: "development:invalid-schema",
          displayName: "Invalid schema",
          source: "development",
          entryPath: "/tmp/invalid-schema.ts",
          hostProfileVersion: 1,
          capabilities: ["plugin-methods.provide"],
          pluginId: "com.example.invalid",
          runCodeSkill: "plugin-invalid",
          runCodeCatalog: {
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
          name: "run",
          label: "Run",
          description: "Run invalid schema",
          parameters,
          async execute() {
            return { content: [{ type: "text", text: "ok" }] };
          },
        },
      ),
    ).toThrow("PLUGIN_SCHEMA_INVALID");
  });

  test("plugin dispatcher rejects invalid arguments", async () => {
    const parameters = Type.Object({ value: Type.Number() }, { additionalProperties: false });
    const builder = new DesktopPluginRegistryBuilder();
    builder.stageTool(
      {
        id: "development:math",
        displayName: "Math",
        source: "development",
        entryPath: "/tmp/math.ts",
        hostProfileVersion: 1,
        capabilities: ["plugin-methods.provide"],
        pluginId: "math",
        runCodeSkill: "plugin-math",
        runCodeCatalog: {
          schemaVersion: 1,
          pluginId: "math",
          methods: [
            {
              name: "double",
              description: "Double",
              parameters: parameters as never,
              result: Type.Object({ text: Type.String() }, { additionalProperties: false }) as never,
              concurrency: "serial",
            },
          ],
        },
      },
      {
        name: "double",
        label: "Double",
        description: "Double",
        parameters,
        async execute() {
          return { content: [{ type: "text", text: "1" }] };
        },
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
  concurrency: "serial" | "parallel" = "serial",
): PluginMethodDispatcher {
  const parameters = Type.Object({ value: Type.Number() }, { additionalProperties: false });
  const method: RegisteredDesktopPluginMethod = {
    pluginId: "com.example.math",
    primarySkill: "plugin-math-helper",
    entryId: "development:math-helper",
    source: "development",
    name: "double",
    description: "Double a number",
    concurrency,
    parameters,
    result: Type.Object({ doubled: Type.Number() }, { additionalProperties: false }),
    execute: (params, signal, context) => execute(params as { value: number }, signal, context),
    validateParameters: (value) =>
      !!value && typeof value === "object" && typeof (value as { value?: unknown }).value === "number",
    validateResult: (value) =>
      !!value && typeof value === "object" && typeof (value as { doubled?: unknown }).doubled === "number",
  };
  return new PluginMethodDispatcher(new Map([[method.pluginId, new Map([[method.name, method]])]]), cwd);
}
