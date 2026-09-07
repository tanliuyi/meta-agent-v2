import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CodexPluginManifest,
  loadCodexPluginManifest,
  parseCodexPluginManifest,
} from "../src/main/plugins/codex/codex-plugin-manifest.ts";

const fixtures = join(import.meta.dirname, "fixtures", "codex", "plugins");

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Probes once whether directory symlinks can be created on this platform. */
const symlinksSupported = await (async () => {
  const dir = join(tmpdir(), `codex-symlink-probe-${Math.random().toString(36).slice(2)}`);
  try {
    await mkdir(dir, { recursive: true });
    await symlink(dir, join(dir, "self"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
})();

async function readFixture(name: string): Promise<string> {
  return readFile(join(fixtures, name, ".codex-plugin", "plugin.json"), "utf8");
}

function createRoot(): string {
  const root = join(tmpdir(), `codex-plugin-manifest-test-${Math.random().toString(36).slice(2)}`);
  tempRoots.push(root);
  return root;
}

describe("parseCodexPluginManifest", () => {
  it("accepts a real dart-flutter Codex plugin manifest", async () => {
    const result = parseCodexPluginManifest(await readFixture("dart-flutter"));
    expect(result.issues).toEqual([]);
    const manifest = result.manifest;
    expect(manifest).toBeDefined();
    expect(manifest?.name).toBe("dart-flutter");
    expect(manifest?.version).toBe("1.0.0");
    expect(manifest?.author).toEqual({ name: "Dart and Flutter", url: "https://flutter.dev" });
    expect(manifest?.skills).toBe("./skills/");
    expect(manifest?.mcpServers).toBe("./.mcp.json");
    expect(manifest?.interface?.displayName).toBe("Dart and Flutter");
    expect(manifest?.interface?.capabilities).toEqual(["Skills", "MCP"]);
  });

  it("accepts a real browser plugin manifest with hooks and interface assets", async () => {
    const result = parseCodexPluginManifest(await readFixture("browser"));
    expect(result.issues).toEqual([]);
    expect(result.manifest?.hooks).toBeDefined();
    expect(result.manifest?.interface?.composerIcon).toBe("./assets/composer-icon.png");
  });

  it("accepts a minimal manifest without interface or companions", () => {
    const jsonText = JSON.stringify({
      name: "codex-app-tools",
      version: "0.1.3",
      description: "Exposes tools through one local MCP server.",
      author: { name: "OpenAI" },
      license: "Proprietary",
    });
    const result = parseCodexPluginManifest(jsonText);
    expect(result.issues).toEqual([]);
    expect(result.manifest).toMatchObject({
      name: "codex-app-tools",
      version: "0.1.3",
      description: "Exposes tools through one local MCP server.",
    });
    expect(result.manifest?.interface).toBeUndefined();
  });

  it("tolerates unknown top-level fields accepted by the Codex host", () => {
    const result = parseCodexPluginManifest(
      JSON.stringify({
        name: "visualize",
        version: "1.0.29",
        description: "Create interactive visuals.",
        author: { name: "OpenAI" },
        bundledContentVariant: "live-disabled",
      }),
    );
    expect(result.issues).toEqual([]);
    expect(result.manifest?.name).toBe("visualize");
  });

  it("rejects malformed JSON", () => {
    expect(parseCodexPluginManifest("{not json")).toEqual({ issues: [{ path: "$", message: "must be valid JSON" }] });
  });

  it("rejects a non-object root", () => {
    const result = parseCodexPluginManifest("[1, 2]");
    expect(result.issues).toEqual([{ path: "$", message: "must contain a JSON object" }]);
    expect(result.manifest).toBeUndefined();
  });

  it("rejects an invalid plugin name", () => {
    for (const name of ["", "my plugin", "my..plugin", "my/plugin"]) {
      const result = parseCodexPluginManifest(
        JSON.stringify({ name, version: "1.0.0", description: "x", author: { name: "a" } }),
      );
      expect(result.issues.some((issue) => issue.path === "$.name")).toBe(true);
    }
  });

  it("accepts valid plugin names including dotted segments", () => {
    const result = parseCodexPluginManifest(
      JSON.stringify({ name: "My.Plugin_Name-1", version: "1.0.0", description: "x", author: { name: "a" } }),
    );
    expect(result.issues).toEqual([]);
  });

  it("rejects a non-semver version", () => {
    for (const version of ["1.0", "1.0.0.0", "01.0.0", "abc", ""]) {
      const result = parseCodexPluginManifest(
        JSON.stringify({ name: "my-plugin", version, description: "x", author: { name: "a" } }),
      );
      expect(result.issues.some((issue) => issue.path === "$.version")).toBe(true);
    }
  });

  it("accepts semver with prerelease and build metadata", () => {
    const result = parseCodexPluginManifest(
      JSON.stringify({
        name: "my-plugin",
        version: "1.2.3-beta.1+codex.local-20260519",
        description: "x",
        author: { name: "a" },
      }),
    );
    expect(result.issues).toEqual([]);
  });

  it("reports missing required fields with stable diagnostics", () => {
    const result = parseCodexPluginManifest(JSON.stringify({ author: { name: "a" } }));
    expect(result.issues).toEqual([
      { path: "$.name", message: "must be a non-empty string" },
      { path: "$.version", message: "must be a non-empty string" },
      { path: "$.description", message: "must be a non-empty string" },
    ]);
  });

  it("rejects an invalid author", () => {
    const missingAuthor = parseCodexPluginManifest(JSON.stringify({ name: "p", version: "1.0.0", description: "x" }));
    expect(missingAuthor.issues).toEqual([{ path: "$.author", message: "must be an object" }]);
    const missingName = parseCodexPluginManifest(
      JSON.stringify({ name: "p", version: "1.0.0", description: "x", author: { email: "a@b.c" } }),
    );
    expect(missingName.issues).toEqual([{ path: "$.author.name", message: "must be a non-empty string" }]);
    const badUrl = parseCodexPluginManifest(
      JSON.stringify({ name: "p", version: "1.0.0", description: "x", author: { name: "a", url: "ftp://x" } }),
    );
    expect(badUrl.issues).toEqual([{ path: "$.author.url", message: "must be an absolute `https://` URL" }]);
  });

  it("validates skills contract paths", () => {
    const manifest = (skills: unknown): Record<string, unknown> => ({
      name: "p",
      version: "1.0.0",
      description: "x",
      author: { name: "a" },
      skills,
    });
    for (const valid of ["./skills/", "skills", "skills/", ".\\skills\\"]) {
      const result = parseCodexPluginManifest(JSON.stringify(manifest(valid)));
      expect(result.issues).toEqual([]);
      expect(result.manifest?.skills).toBe(valid);
    }
    for (const invalid of ["../skills", "./skills/extra", "C:\\skills", "/skills", 42]) {
      const result = parseCodexPluginManifest(JSON.stringify(manifest(invalid)));
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0]?.path).toBe("$.skills");
    }
  });

  it("validates apps and mcpServers contract paths", () => {
    const base = { name: "p", version: "1.0.0", description: "x", author: { name: "a" } };
    const apps = parseCodexPluginManifest(JSON.stringify({ ...base, apps: ".app.json" }));
    expect(apps.issues).toEqual([]);
    const badApps = parseCodexPluginManifest(JSON.stringify({ ...base, apps: "./apps.json" }));
    expect(badApps.issues).toEqual([{ path: "$.apps", message: "must resolve to `.app.json`" }]);
    const mcp = parseCodexPluginManifest(JSON.stringify({ ...base, mcpServers: ".mcp.json" }));
    expect(mcp.issues).toEqual([]);
    const badMcp = parseCodexPluginManifest(JSON.stringify({ ...base, mcpServers: "../.mcp.json" }));
    expect(badMcp.issues).toEqual([{ path: "$.mcpServers", message: "must resolve to `.mcp.json`" }]);
    const absoluteMcp = parseCodexPluginManifest(JSON.stringify({ ...base, mcpServers: "/abs/.mcp.json" }));
    expect(absoluteMcp.issues).toEqual([{ path: "$.mcpServers", message: "must be a relative path" }]);
  });

  it("validates inline mcpServers objects", () => {
    const base = { name: "p", version: "1.0.0", description: "x", author: { name: "a" } };
    const valid = parseCodexPluginManifest(
      JSON.stringify({
        ...base,
        mcpServers: {
          "dart-mcp-server": { command: "dart", args: ["mcp-server"], env: {} },
          "empty-server": {},
        },
      }),
    );
    expect(valid.issues).toEqual([]);
    const badName = parseCodexPluginManifest(JSON.stringify({ ...base, mcpServers: { "": { command: "x" } } }));
    expect(badName.issues).toEqual([{ path: "$.mcpServers", message: "server names must be non-empty strings" }]);
    const badServer = parseCodexPluginManifest(JSON.stringify({ ...base, mcpServers: { s: "not-an-object" } }));
    expect(badServer.issues).toEqual([{ path: "$.mcpServers.s", message: "must be an object" }]);
    const badType = parseCodexPluginManifest(JSON.stringify({ ...base, mcpServers: 42 }));
    expect(badType.issues).toEqual([{ path: "$.mcpServers", message: "must be a string path or object" }]);
  });

  it("rejects [TODO: ...] placeholders anywhere in the manifest", () => {
    const inDescription = parseCodexPluginManifest(
      JSON.stringify({
        name: "p",
        version: "1.0.0",
        description: "Add [TODO: implement] later",
        author: { name: "a" },
      }),
    );
    expect(inDescription.issues).toEqual([
      { path: "$.description", message: "must not contain a `[TODO: ...]` placeholder" },
    ]);
    const nested = parseCodexPluginManifest(
      JSON.stringify({
        name: "p",
        version: "1.0.0",
        description: "x",
        author: { name: "a" },
        interface: { displayName: "[TODO: title]" },
      }),
    );
    expect(nested.issues.some((issue) => issue.path === "$.interface.displayName")).toBe(true);
  });

  it("validates interface fields", () => {
    const base = { name: "p", version: "1.0.0", description: "x", author: { name: "a" } };
    const notObject = parseCodexPluginManifest(JSON.stringify({ ...base, interface: "nope" }));
    expect(notObject.issues).toEqual([{ path: "$.interface", message: "must be an object" }]);
    const badBrand = parseCodexPluginManifest(
      JSON.stringify({ ...base, interface: { displayName: "d", brandColor: "blue" } }),
    );
    expect(badBrand.issues).toEqual([{ path: "$.interface.brandColor", message: "must use `#RRGGBB`" }]);
    const badUrl = parseCodexPluginManifest(
      JSON.stringify({ ...base, interface: { displayName: "d", websiteURL: "http://example.com" } }),
    );
    expect(badUrl.issues).toEqual([{ path: "$.interface.websiteURL", message: "must be an absolute `https://` URL" }]);
    const badCapabilities = parseCodexPluginManifest(
      JSON.stringify({ ...base, interface: { displayName: "d", capabilities: ["ok", 3] } }),
    );
    expect(badCapabilities.issues).toEqual([
      { path: "$.interface.capabilities", message: "must be an array of strings" },
    ]);
    const badPrompt = parseCodexPluginManifest(
      JSON.stringify({ ...base, interface: { displayName: "d", defaultPrompt: "not-an-array" } }),
    );
    expect(badPrompt.issues).toEqual([{ path: "$.interface.defaultPrompt", message: "must be an array of strings" }]);
  });

  it("rejects empty asset paths at parse time", () => {
    const base = { name: "p", version: "1.0.0", description: "x", author: { name: "a" } };
    for (const assetPath of [".", "./", ".\\"]) {
      const result = parseCodexPluginManifest(
        JSON.stringify({ ...base, interface: { displayName: "d", logo: assetPath } }),
      );
      expect(result.issues).toEqual([
        { path: "$.interface.logo", message: "must be a non-empty relative path inside the plugin archive" },
      ]);
    }
    const badScreenshots = parseCodexPluginManifest(
      JSON.stringify({ ...base, interface: { displayName: "d", screenshots: ["./"] } }),
    );
    expect(badScreenshots.issues).toEqual([
      { path: "$.interface.screenshots[0]", message: "must be a non-empty relative path inside the plugin archive" },
    ]);
  });

  it("accepts asset paths whose first segment merely starts with two dots", () => {
    const result = parseCodexPluginManifest(
      JSON.stringify({
        name: "p",
        version: "1.0.0",
        description: "x",
        author: { name: "a" },
        interface: { displayName: "d", logo: "./..cache/icon.png" },
      }),
    );
    expect(result.issues).toEqual([]);
    expect(result.manifest?.interface?.logo).toBe("./..cache/icon.png");
  });

  it("validates optional manifest fields", () => {
    const base = { name: "p", version: "1.0.0", description: "x", author: { name: "a" } };
    const badId = parseCodexPluginManifest(JSON.stringify({ ...base, id: 42 }));
    expect(badId.issues).toEqual([{ path: "$.id", message: "must be a non-empty string" }]);
    const badHomepage = parseCodexPluginManifest(JSON.stringify({ ...base, homepage: "" }));
    expect(badHomepage.issues).toEqual([{ path: "$.homepage", message: "must be a non-empty string" }]);
    const badKeywords = parseCodexPluginManifest(JSON.stringify({ ...base, keywords: ["ok", 3] }));
    expect(badKeywords.issues).toEqual([{ path: "$.keywords", message: "must be an array of strings" }]);
    const valid = parseCodexPluginManifest(
      JSON.stringify({
        ...base,
        id: "p",
        homepage: "https://example.com",
        repository: "https://github.com/x/p",
        license: "MIT",
        keywords: ["code", "test"],
      }),
    );
    expect(valid.issues).toEqual([]);
    expect(valid.manifest).toMatchObject({ id: "p", license: "MIT", keywords: ["code", "test"] });
  });

  it("returns no manifest when any validation issue is present", () => {
    const result = parseCodexPluginManifest(
      JSON.stringify({ name: "p", version: "1.0.0", description: "x", author: { name: "a", url: "ftp://x" } }),
    );
    expect(result.issues).toEqual([{ path: "$.author.url", message: "must be an absolute `https://` URL" }]);
    expect(result.manifest).toBeUndefined();
  });

  it("rejects absolute and traversing asset paths", () => {
    const base = { name: "p", version: "1.0.0", description: "x", author: { name: "a" } };
    for (const assetPath of [
      "C:\\outside.png",
      "/outside.png",
      "../outside.png",
      "..\\outside.png",
      "./a/../../b.png",
      "",
    ]) {
      const result = parseCodexPluginManifest(
        JSON.stringify({ ...base, interface: { displayName: "d", logo: assetPath } }),
      );
      expect(result.issues.some((issue) => issue.path === "$.interface.logo")).toBe(true);
    }
    const badScreenshots = parseCodexPluginManifest(
      JSON.stringify({ ...base, interface: { displayName: "d", screenshots: ["assets/ok.png", "../escape.png"] } }),
    );
    expect(badScreenshots.issues).toEqual([
      { path: "$.interface.screenshots[1]", message: "must be a non-empty relative path inside the plugin archive" },
    ]);
  });
});

describe("loadCodexPluginManifest", () => {
  it("loads a real dart-flutter plugin layout from disk", async () => {
    const result = await loadCodexPluginManifest(join(fixtures, "dart-flutter"));
    expect(result.issues).toEqual([]);
    expect(result.manifest?.name).toBe("dart-flutter");
  });

  it("loads a real browser plugin layout with asset files", async () => {
    const result = await loadCodexPluginManifest(join(fixtures, "browser"));
    expect(result.issues).toEqual([]);
    expect(result.manifest?.interface?.screenshots).toEqual([]);
  });

  it("reports a missing manifest", async () => {
    const result = await loadCodexPluginManifest(createRoot());
    expect(result.issues).toEqual([{ path: "$", message: "missing `.codex-plugin/plugin.json`" }]);
  });

  it("reports missing companions when declared", async () => {
    const root = createRoot();
    await mkdir(join(root, ".codex-plugin"), { recursive: true });
    await writeFile(
      join(root, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "p",
        version: "1.0.0",
        description: "x",
        author: { name: "a" },
        skills: "./skills/",
        apps: ".app.json",
        mcpServers: ".mcp.json",
      }),
    );
    const result = await loadCodexPluginManifest(root);
    expect(result.issues).toEqual([
      { path: "$.skills", message: "companion directory `skills` is missing" },
      { path: "$.apps", message: "companion file `.app.json` is missing" },
      { path: "$.mcpServers", message: "companion file `.mcp.json` is missing" },
    ]);
    expect(result.manifest).toBeUndefined();
  });

  it("rejects a malformed companion JSON", async () => {
    const root = createRoot();
    await mkdir(join(root, ".codex-plugin"), { recursive: true });
    await writeFile(
      join(root, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "p", version: "1.0.0", description: "x", author: { name: "a" }, mcpServers: ".mcp.json" }),
    );
    await writeFile(join(root, ".mcp.json"), "{broken");
    const result = await loadCodexPluginManifest(root);
    expect(result.issues).toEqual([{ path: "$.mcpServers", message: "must be valid JSON" }]);
  });

  it("reports missing asset files referenced by the interface", async () => {
    const root = createRoot();
    await mkdir(join(root, ".codex-plugin"), { recursive: true });
    await writeFile(
      join(root, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "p",
        version: "1.0.0",
        description: "x",
        author: { name: "a" },
        interface: { displayName: "d", logo: "./assets/logo.png" },
      }),
    );
    const result = await loadCodexPluginManifest(root);
    expect(result.issues).toEqual([{ path: "$.interface.logo", message: "points to a missing file" }]);
  });

  it.skipIf(!symlinksSupported)("resolves asset files through symlinks without escaping the plugin root", async () => {
    const outsideRoot = join(tmpdir(), `codex-escape-target-${Math.random().toString(36).slice(2)}`);
    tempRoots.push(outsideRoot);
    await mkdir(join(outsideRoot, "sub"), { recursive: true });
    await writeFile(join(outsideRoot, "sub", "logo.png"), "x");
    const root = createRoot();
    await mkdir(join(root, ".codex-plugin"), { recursive: true });
    await mkdir(join(root, "assets"), { recursive: true });
    await symlink(outsideRoot, join(root, "assets", "logo.png"), "dir");
    await writeFile(
      join(root, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "p",
        version: "1.0.0",
        description: "x",
        author: { name: "a" },
        interface: { displayName: "d", logo: "./assets/logo.png" },
      }),
    );
    const result = await loadCodexPluginManifest(root);
    expect(result.issues).toEqual([{ path: "$.interface.logo", message: "must stay inside the plugin archive" }]);
  });

  it.skipIf(!symlinksSupported)("rejects a companion file symlinked outside the plugin root", async () => {
    const outsideRoot = join(tmpdir(), `codex-escape-target-${Math.random().toString(36).slice(2)}`);
    tempRoots.push(outsideRoot);
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(join(outsideRoot, "mcp.json"), JSON.stringify({ mcpServers: { evil: { command: "x" } } }));
    const root = createRoot();
    await mkdir(join(root, ".codex-plugin"), { recursive: true });
    await symlink(join(outsideRoot, "mcp.json"), join(root, ".mcp.json"));
    await writeFile(
      join(root, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "p", version: "1.0.0", description: "x", author: { name: "a" }, mcpServers: ".mcp.json" }),
    );
    const result = await loadCodexPluginManifest(root);
    expect(result.issues).toEqual([{ path: "$.mcpServers", message: "must stay inside the plugin archive" }]);
  });

  it.skipIf(!symlinksSupported)("accepts a skills directory symlinked inside the plugin root", async () => {
    const root = createRoot();
    await mkdir(join(root, ".codex-plugin"), { recursive: true });
    await mkdir(join(root, "real-skills"), { recursive: true });
    await symlink(join(root, "real-skills"), join(root, "skills"), "dir");
    await writeFile(
      join(root, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "p", version: "1.0.0", description: "x", author: { name: "a" }, skills: "./skills/" }),
    );
    const result = await loadCodexPluginManifest(root);
    expect(result.issues).toEqual([]);
  });

  it.skipIf(!symlinksSupported)("rejects a skills directory symlinked outside the plugin root", async () => {
    const outsideRoot = join(tmpdir(), `codex-escape-target-${Math.random().toString(36).slice(2)}`);
    tempRoots.push(outsideRoot);
    await mkdir(outsideRoot, { recursive: true });
    const root = createRoot();
    await mkdir(join(root, ".codex-plugin"), { recursive: true });
    await symlink(outsideRoot, join(root, "skills"), "dir");
    await writeFile(
      join(root, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "p", version: "1.0.0", description: "x", author: { name: "a" }, skills: "./skills/" }),
    );
    const result = await loadCodexPluginManifest(root);
    expect(result.issues).toEqual([{ path: "$.skills", message: "must stay inside the plugin archive" }]);
  });

  it("accepts a directory whose name starts with two dots inside the plugin root", async () => {
    const root = createRoot();
    await mkdir(join(root, ".codex-plugin"), { recursive: true });
    await mkdir(join(root, "..cache"), { recursive: true });
    await writeFile(join(root, "..cache", "icon.png"), "x");
    await writeFile(
      join(root, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "p",
        version: "1.0.0",
        description: "x",
        author: { name: "a" },
        interface: { displayName: "d", logo: "./..cache/icon.png" },
      }),
    );
    const result = await loadCodexPluginManifest(root);
    expect(result.issues).toEqual([]);
  });

  it("accepts a valid .app.json companion", async () => {
    const root = createRoot();
    await mkdir(join(root, ".codex-plugin"), { recursive: true });
    await writeFile(join(root, ".app.json"), JSON.stringify({ apps: { "my-app": ["pi"] } }));
    await writeFile(
      join(root, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "p", version: "1.0.0", description: "x", author: { name: "a" }, apps: ".app.json" }),
    );
    const result = await loadCodexPluginManifest(root);
    expect(result.issues).toEqual([]);
  });

  it("does not mutate a manifest it validates", async () => {
    const root = createRoot();
    await mkdir(join(root, ".codex-plugin"), { recursive: true });
    const manifestText = JSON.stringify({ name: "p", version: "1.0.0", description: "x", author: { name: "a" } });
    await writeFile(join(root, ".codex-plugin", "plugin.json"), manifestText);
    await loadCodexPluginManifest(root);
    expect(await readFile(join(root, ".codex-plugin", "plugin.json"), "utf8")).toBe(manifestText);
  });
});

describe("manifest model shape", () => {
  it("parses an unknown `hooks` declaration into the typed model", () => {
    const hooks = { hooks: { Stop: [{ hooks: [{ type: "mcp_tool", server: "node_repl" }] }] } };
    const result = parseCodexPluginManifest(
      JSON.stringify({ name: "browser", version: "26.901.51231", description: "x", author: { name: "OpenAI" }, hooks }),
    );
    expect(result.issues).toEqual([]);
    expect(result.manifest?.hooks).toEqual(hooks);
  });

  it("keeps typed fields erasable (no class instances)", () => {
    const result = parseCodexPluginManifest(
      JSON.stringify({ name: "p", version: "1.0.0", description: "x", author: { name: "a" } }),
    );
    const manifest = result.manifest as CodexPluginManifest | undefined;
    expect(manifest?.constructor).toBe(Object);
  });
});
