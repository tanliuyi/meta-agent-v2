import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createAgentSessionServices, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopExtensionSettingsService } from "../src/main/extensions/desktop-extension-settings-service.ts";
import { DesktopExtensionSourcePolicy } from "../src/main/extensions/desktop-extension-source-policy.ts";
import { executeCodexScript } from "../src/main/pi/codex-script-process.ts";
import {
  controlledResourceLoaderOptions,
  isBlockingExtensionDiagnostic,
  validatePluginSkills,
  validateResolvedExtensionSet,
} from "../src/main/pi/desktop-extension-runtime-policy.ts";
import { loadCodexPluginCompanions } from "../src/main/plugins/codex/codex-plugin-companions.ts";
import { CodexPluginInstaller } from "../src/main/plugins/codex/codex-plugin-installer.ts";
import type { CodexPluginManifest } from "../src/main/plugins/codex/codex-plugin-manifest.ts";
import { CodexPluginRegistry } from "../src/main/plugins/codex/codex-plugin-registry.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string> = {}, extra: Partial<CodexPluginManifest> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-companions-")));
  directories.push(root);
  const manifest: CodexPluginManifest = {
    name: "companion-test",
    version: "1.0.0",
    description: "Test",
    author: { name: "Test" },
    ...extra,
  };
  const managedRoot = join(root, "plugin");
  const pluginRoot = join(managedRoot, ".versions", "a".repeat(64));
  for (const [path, text] of Object.entries({ ".codex-plugin/plugin.json": JSON.stringify(manifest), ...files })) {
    await mkdir(dirname(join(pluginRoot, path)), { recursive: true });
    await writeFile(join(pluginRoot, path), text);
  }
  const record = {
    id: manifest.name,
    displayName: "Companion test",
    version: "1.0.0",
    rootPath: pluginRoot,
    marketplacePath: join(root, "marketplace.json"),
    sourcePath: "./plugins/companion-test",
    enabled: true,
    discoveredAt: 1,
    installedRootPath: managedRoot as string | undefined,
    installedHash: "a".repeat(64) as string | undefined,
  };
  const policy = new DesktopExtensionSourcePolicy({
    settings: new DesktopExtensionSettingsService(root, { builtinDefinitions: [], curatedDefinitions: [] }),
    getBuiltinDefinitions: () => [],
    getCuratedDefinitions: () => [],
    getCodexExtensions: async () => ({ revision: "unchanged", plugins: [record] }),
  });
  return { root, pluginRoot, manifest, record, policy };
}

async function load(f: Awaited<ReturnType<typeof fixture>>) {
  const set = await validateResolvedExtensionSet("project", await f.policy.resolve("project"));
  const services = await createAgentSessionServices({
    cwd: f.root,
    agentDir: join(f.root, "agent"),
    resourceLoaderOptions: {
      ...controlledResourceLoaderOptions(set, [], { includeBuiltinSkills: false }),
      noSkills: true,
    },
  });
  expect(services.resourceLoader.getExtensions().errors).toEqual([]);
  const tools = services.resourceLoader
    .getExtensions()
    .extensions.flatMap((extension) => [...extension.tools.values()].map(({ definition }) => definition));
  const invoke = (suffix: string, params: Record<string, unknown>, signal?: AbortSignal) => {
    const tool = tools.find(({ name }) => name.endsWith(suffix));
    if (!tool) throw new Error(`Tool missing: ${suffix}`);
    return tool.execute("call", params, signal, undefined, {} as ExtensionContext);
  };
  return { set, services, tools, invoke };
}

describe("Codex companion discovery and sidecar loading", () => {
  it("loads the installer's version payload through install, update and uninstall", async () => {
    const f = await fixture({ "scripts/echo.mjs": "console.log('installed');" });
    const registry = new CodexPluginRegistry(join(f.root, "user-data"));
    const snapshot = await registry.reconcile([
      {
        name: f.record.id,
        version: f.record.version,
        displayName: f.record.displayName,
        rootPath: f.pluginRoot,
        marketplacePath: f.record.marketplacePath,
        sourcePath: f.record.sourcePath,
      },
    ]);
    f.policy = new DesktopExtensionSourcePolicy({
      settings: new DesktopExtensionSettingsService(f.root, { builtinDefinitions: [], curatedDefinitions: [] }),
      getBuiltinDefinitions: () => [],
      getCuratedDefinitions: () => [],
      getCodexExtensions: () => registry.getSnapshot(),
    });
    const installer = new CodexPluginInstaller(registry, join(f.root, "locks"), join(f.root, "installed"));
    expect((await load(f)).tools).toEqual([]);
    const installed = await installer.install({
      pluginId: f.record.id,
      requestId: "install",
      expectedRevision: snapshot.revision,
      confirmFullTrust: true,
    });
    if (installed.status !== "installed") throw new Error("install failed");
    const first = await load(f);
    expect((await first.invoke("_script", { script: join("scripts", "echo.mjs") })).content).toEqual([
      { type: "text", text: "installed\n" },
    ]);
    await writeFile(join(f.pluginRoot, "scripts", "echo.mjs"), "console.log('updated');");
    expect((await first.invoke("_script", { script: join("scripts", "echo.mjs") })).content).toEqual([
      { type: "text", text: "installed\n" },
    ]);
    const updated = await installer.update({
      pluginId: f.record.id,
      requestId: "update",
      expectedRevision: installed.snapshot.revision,
      confirmFullTrust: true,
    });
    if (updated.status !== "updated") throw new Error("update failed");
    const second = await load(f);
    expect((await first.invoke("_script", { script: join("scripts", "echo.mjs") })).content).toEqual([
      { type: "text", text: "installed\n" },
    ]);
    await expect(validateResolvedExtensionSet("project", first.set)).resolves.toMatchObject({
      generation: first.set.generation,
    });
    expect(second.set.generation).not.toBe(first.set.generation);
    expect((await second.invoke("_script", { script: join("scripts", "echo.mjs") })).content).toEqual([
      { type: "text", text: "updated\n" },
    ]);
    await installer.uninstall({
      pluginId: f.record.id,
      requestId: "remove",
      expectedRevision: updated.snapshot.revision,
      confirmRemoval: true,
    });
    expect((await load(f)).tools).toEqual([]);
    expect((await second.invoke("_script", { script: join("scripts", "echo.mjs") })).content).toEqual([
      { type: "text", text: "updated\n" },
    ]);
  });

  it("loads default skills without Pi metadata and does not execute scripts during discovery or draft loading", async () => {
    const f = await fixture({
      "skills/review/SKILL.md": "---\nname: review\ndescription: Review the code.\n---\nRead the code.\n",
      "scripts/echo.mjs":
        'import { writeFileSync } from "node:fs"; writeFileSync("ran", "yes"); console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));',
    });
    const loaded = await load(f);
    expect(loaded.services.resourceLoader.getSkills().skills.map(({ name }) => name)).toEqual([
      "companion-test:review",
    ]);
    expect(loaded.set.entries[0]?.entryPath).toBeUndefined();
    await expect(access(join(f.pluginRoot, "ran"))).rejects.toThrow();
    const result = await loaded.invoke("_script", {
      script: join("scripts", "echo.mjs"),
      args: ["$(echo unsafe)", "two words"],
    });
    expect(result.content).toEqual([
      { type: "text", text: `${JSON.stringify({ args: ["$(echo unsafe)", "two words"], cwd: f.pluginRoot })}\n` },
    ]);
    expect(await readFile(join(f.pluginRoot, "ran"), "utf8")).toBe("yes");
    await expect(loaded.invoke("_script", { script: "../outside.mjs" })).rejects.toThrow("CODEX_SCRIPT_NOT_APPROVED");
  });

  it("executes Python explicitly and respects cancellation", async () => {
    const f = await fixture({
      "scripts/echo.py": "import sys\nprint(sys.argv[1])\n",
      "scripts/wait.mjs": "setInterval(() => {}, 1000);",
    });
    const loaded = await load(f);
    expect(
      (await loaded.invoke("_script", { script: join("scripts", "echo.py"), args: ["python-ok"] })).content,
    ).toEqual([{ type: "text", text: "python-ok\n" }]);
    await expect(
      loaded.invoke("_script", { script: join("scripts", "wait.mjs") }, AbortSignal.timeout(100)),
    ).rejects.toThrow();
  });

  it("keeps same-named plugin skills and follows skill root and ignore semantics", async () => {
    const skill = "---\nname: review\ndescription: Review.\n---\nRead.\n";
    const first = await fixture({
      "skills/review/SKILL.md": skill,
      "skills/review/examples/sample/SKILL.md": skill.replace("review", "sample"),
      "skills/.ignore": "ignored/\n",
      "skills/ignored/SKILL.md": skill.replace("review", "ignored"),
      "skills/.hidden/SKILL.md": skill.replace("review", "hidden"),
      "skills/node_modules/SKILL.md": skill.replace("review", "dependencies"),
      "skills/invalid/SKILL.md": "---\nname: invalid\n---\nNo description.",
    });
    const second = await fixture({ "skills/review/SKILL.md": skill }, { name: "second-plugin" });
    const set = await first.policy.resolve("project");
    set.entries.push(...(await second.policy.resolve("project")).entries);
    const services = await createAgentSessionServices({
      cwd: first.root,
      agentDir: join(first.root, "agent"),
      resourceLoaderOptions: {
        ...controlledResourceLoaderOptions(set, [], { includeBuiltinSkills: false }),
        noSkills: true,
      },
    });
    const loaded = services.resourceLoader.getSkills();
    expect(loaded.skills.map(({ name }) => name)).toEqual(["companion-test:review", "second-plugin:review"]);
    expect(validatePluginSkills(set, loaded)).toEqual([
      expect.objectContaining({ extensionId: "companion-test", code: "CODEX_SKILL_INVALID" }),
    ]);
    const before = await first.policy.resolve("project");
    await writeFile(join(first.pluginRoot, "skills/review/examples/sample/SKILL.md"), `${skill}\nChanged example.`);
    expect((await first.policy.resolve("project")).generation).not.toBe(before.generation);
  });

  it.each(["cancel", "timeout", "shutdown"])("cleans up script grandchildren on %s", async (mode) => {
    const f = await fixture({
      "scripts/parent.mjs": `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync('child.pid', String(child.pid));
setInterval(() => {}, 1000);`,
    });
    const loaded = await load(f);
    const controller = new AbortController();
    const execution =
      mode === "timeout"
        ? executeCodexScript(process.execPath, [join(f.pluginRoot, "scripts/parent.mjs")], {
            cwd: f.pluginRoot,
            env: process.env,
            signal: controller.signal,
            timeoutMs: 500,
          })
        : loaded.invoke("_script", { script: join("scripts", "parent.mjs") }, controller.signal);
    const settled = execution.then(
      () => undefined,
      (error: unknown) => error,
    );
    let pid: number | undefined;
    try {
      await vi.waitFor(
        async () => {
          pid = Number(await readFile(join(f.pluginRoot, "child.pid"), "utf8"));
        },
        { timeout: 2000 },
      );
      if (mode === "cancel") controller.abort();
      if (mode === "shutdown") {
        for (const extension of loaded.services.resourceLoader.getExtensions().extensions) {
          for (const handler of extension.handlers.get("session_shutdown") ?? []) {
            await handler({ type: "session_shutdown", reason: "quit" }, {} as ExtensionContext);
          }
        }
      }
      expect(await settled).toBeInstanceOf(Error);
      await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow());
    } finally {
      controller.abort();
      await settled;
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
    }
  });

  it("requires installation and excludes resources again after uninstall", async () => {
    const f = await fixture({ "scripts/echo.mjs": "console.log('ok');" });
    expect((await f.policy.resolve("project")).entries).toHaveLength(1);
    f.record.installedRootPath = undefined;
    f.record.installedHash = undefined;
    expect((await f.policy.resolve("project")).entries).toHaveLength(0);
  });

  it("detects changed companion bytes and prevents a stale worker snapshot", async () => {
    const f = await fixture({ "scripts/echo.mjs": "console.log('first');" });
    const first = await f.policy.resolve("project");
    await writeFile(join(f.pluginRoot, "scripts", "echo.mjs"), "console.log('second');");
    await expect(validateResolvedExtensionSet("project", first)).rejects.toThrow("changed since resolution");
    const second = await f.policy.resolve("project");
    expect(second.generation).not.toBe(first.generation);
    second.entries[0]!.codexCompanions!.scripts.push("unapproved.mjs");
    expect((await f.policy.resolve("project")).entries[0]?.codexCompanions?.scripts).not.toContain("unapproved.mjs");
  });

  it("rejects escaping symlinks during discovery and after script approval", async () => {
    const f = await fixture({ "scripts/echo.mjs": "console.log('ok');" });
    const loaded = await load(f);
    const outside = join(f.root, "outside.mjs");
    await writeFile(outside, "throw new Error('must not run');");
    await rm(join(f.pluginRoot, "scripts", "echo.mjs"));
    await symlink(outside, join(f.pluginRoot, "scripts", "echo.mjs"));
    await expect(loaded.invoke("_script", { script: join("scripts", "echo.mjs") })).rejects.toThrow("escapes");
    const discovered = await loadCodexPluginCompanions(f.pluginRoot, f.manifest);
    expect(discovered.resources.scripts).toEqual([]);
    expect(discovered.diagnostics[0]?.code).toBe("CODEX_COMPANION_INVALID");
  });

  it("reports unsupported Apps, hooks and script entry types without blocking valid skills", async () => {
    const f = await fixture(
      {
        "skills/review/SKILL.md": "---\nname: review\ndescription: Review.\n---\nRead.\n",
        ".app.json": JSON.stringify({ apps: { github: { id: "connector_test" } } }),
        "hooks/hooks.json": "{}",
        "scripts/task.sh": "exit 1",
      },
      { hooks: "./hooks/hooks.json" },
    );
    const loaded = await load(f);
    expect(loaded.set.diagnostics).toHaveLength(3);
    expect(
      loaded.set.diagnostics.every(
        (diagnostic) => diagnostic.code === "CODEX_COMPANION_UNSUPPORTED" && !isBlockingExtensionDiagnostic(diagnostic),
      ),
    ).toBe(true);
    expect(loaded.services.resourceLoader.getSkills().skills).toHaveLength(1);
  });

  it.each([".mcp.json", ".app.json"])("reports malformed %s", async (name) => {
    const f = await fixture({ [name]: "{broken" });
    const result = await loadCodexPluginCompanions(f.pluginRoot, f.manifest);
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "CODEX_COMPANION_INVALID" })]);
  });

  it.each([
    { type: "sse", url: "https://example.test" },
    { command: "node", enabled_tools: ["echo"] },
    { command: "node", env: { KEY: "$" + "{MISSING}" } },
  ])("reports unsupported MCP forms without connecting", async (server) => {
    const f = await fixture({ ".mcp.json": JSON.stringify({ mcpServers: { test: server } }) });
    const result = await loadCodexPluginCompanions(f.pluginRoot, f.manifest);
    expect(result.resources.mcpServers).toEqual({});
    expect(result.diagnostics[0]?.code).toBe("CODEX_COMPANION_UNSUPPORTED");
  });

  it("merges inline and default MCP declarations and rejects duplicate names", async () => {
    const f = await fixture(
      {
        ".mcp.json": JSON.stringify({
          mcpServers: { duplicated: { command: "node" }, file: { command: "node", cwd: "./" } },
        }),
      },
      {
        mcpServers: { duplicated: { command: "node" }, inline: { type: "http", url: "https://example.test/mcp" } },
      },
    );
    const result = await loadCodexPluginCompanions(f.pluginRoot, f.manifest);
    expect(Object.keys(result.resources.mcpServers).sort()).toEqual(["file", "inline"]);
    expect(result.diagnostics[0]?.code).toBe("CODEX_COMPANION_INVALID");
  });

  it("lists and calls a real stdio MCP server only on invocation and closes its process", async () => {
    const f = await fixture();
    const marker = join(f.root, "started");
    await writeFile(
      join(f.pluginRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          echo: {
            command: process.execPath,
            args: [resolve("test/fixtures/codex-mcp-server.mjs")],
            env: { START_MARKER: marker },
          },
        },
      }),
    );
    const loaded = await load(f);
    await expect(access(marker)).rejects.toThrow();
    const listed = await loaded.invoke("_mcp", { server: "echo" });
    expect(JSON.stringify(listed.content)).toContain("inputSchema");
    const called = await loaded.invoke("_mcp", { server: "echo", tool: "echo", arguments: { value: "stdio-ok" } });
    expect(JSON.stringify(called.content)).toContain("stdio-ok");
    await expect(loaded.invoke("_mcp", { server: "echo", tool: "wait" }, AbortSignal.timeout(100))).rejects.toThrow(
      "CODEX_MCP_CANCELLED",
    );
    for (const pid of (await readFile(marker, "utf8")).trim().split("\n").map(Number)) {
      expect(() => process.kill(pid, 0)).toThrow();
    }
    await expect(loaded.invoke("_mcp", { server: "constructor" })).rejects.toThrow("CODEX_MCP_SERVER_NOT_APPROVED");
  });

  it("uses Streamable HTTP MCP with headers and preserves tool error results", async () => {
    const requests: string[] = [];
    let terminated = 0;
    const server = createServer(async (request, response) => {
      if (request.method === "DELETE") {
        terminated++;
        response.writeHead(200).end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      expect(request.headers.authorization).toBe("Bearer fixture");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const rpc = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(rpc.method);
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        rpc.method === "initialize"
          ? {
              protocolVersion: rpc.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "http-fixture", version: "1.0.0" },
            }
          : rpc.method === "tools/list"
            ? { tools: [] }
            : { isError: true, content: [{ type: "text", text: "fixture-tool-error" }] };
      response
        .writeHead(200, { "content-type": "application/json", "mcp-session-id": "fixture-session" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing address");
      const f = await fixture(
        {},
        {
          mcpServers: {
            http: {
              type: "http",
              url: `http://127.0.0.1:${address.port}/mcp`,
              headers: { Authorization: "Bearer fixture" },
            },
          },
        },
      );
      const loaded = await load(f);
      expect(requests).toEqual([]);
      await loaded.invoke("_mcp", { server: "http" });
      const result = await loaded.invoke("_mcp", { server: "http", tool: "fail" });
      expect(JSON.stringify(result.content)).toContain("fixture-tool-error");
      expect(requests).toContain("tools/list");
      expect(requests).toContain("tools/call");
      expect(terminated).toBe(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
