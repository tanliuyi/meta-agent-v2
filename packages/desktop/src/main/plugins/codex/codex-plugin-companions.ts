import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import type { CodexMcpServer, CodexPluginCompanions } from "../../../shared/codex-plugin-companions.ts";
import type { CodexPluginManifest } from "./codex-plugin-manifest.ts";

export interface CodexCompanionDiagnostic {
  code: "CODEX_COMPANION_INVALID" | "CODEX_COMPANION_UNSUPPORTED";
  message: string;
}

/** Data-only discovery: no plugin import, process launch, network or credentials. */
export async function loadCodexPluginCompanions(root: string, manifest: CodexPluginManifest) {
  const rootPath = await realpath(root);
  const diagnostics: CodexCompanionDiagnostic[] = [];
  const resources: CodexPluginCompanions = {
    rootPath,
    fingerprint: "",
    skillPaths: [],
    scripts: [],
    mcpServers: {},
  };
  const hashes: string[] = [];
  for (const directory of ["skills", "scripts"] as const) {
    try {
      if (!(await exists(join(rootPath, directory)))) continue;
      const files = await collectFiles(rootPath, directory);
      for (const file of files) {
        hashes.push(
          `${file}:${createHash("sha256")
            .update(await readFile(join(rootPath, file)))
            .digest("hex")}`,
        );
        if (directory === "scripts" && [".js", ".mjs", ".cjs", ".py"].includes(extname(file))) {
          resources.scripts.push(file);
        }
        if (directory === "scripts" && [".sh", ".ps1", ".bat", ".cmd", ".ts"].includes(extname(file))) {
          diagnostics.push({
            code: "CODEX_COMPANION_UNSUPPORTED",
            message: `scripts: unsupported entry type ${extname(file)}; use a skill with an explicit interpreter command`,
          });
        }
      }
      // Hash every supporting file, but let the shared skill loader discover
      // roots and apply ignore rules instead of treating examples as skills.
      if (directory === "skills") resources.skillPaths.push(join(rootPath, directory));
    } catch {
      resources[directory === "skills" ? "skillPaths" : "scripts"] = [];
      diagnostics.push({
        code: "CODEX_COMPANION_INVALID",
        message: `${directory}: inaccessible or escaping plugin root`,
      });
    }
  }
  try {
    const config = await readCompanion(rootPath, ".mcp.json");
    if (
      config !== undefined &&
      (!isRecord(config) || !isRecord(config.mcpServers) || Object.keys(config).some((key) => key !== "mcpServers"))
    ) {
      throw new Error("invalid MCP envelope");
    }
    const inline = typeof manifest.mcpServers === "object" ? manifest.mcpServers : {};
    const fromFile = isRecord(config) && isRecord(config.mcpServers) ? config.mcpServers : {};
    const seen = new Set<string>();
    for (const [name, value] of [...Object.entries(fromFile), ...Object.entries(inline)]) {
      if (seen.has(name)) {
        delete resources.mcpServers[name];
        diagnostics.push({ code: "CODEX_COMPANION_INVALID", message: "mcpServers: duplicate server declaration" });
        continue;
      }
      seen.add(name);
      try {
        if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error("invalid name");
        Object.defineProperty(resources.mcpServers, name, {
          value: await parseServer(value, rootPath),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      } catch (error) {
        diagnostics.push({
          code: error instanceof UnsupportedCompanion ? "CODEX_COMPANION_UNSUPPORTED" : "CODEX_COMPANION_INVALID",
          message: `mcpServers: ${error instanceof UnsupportedCompanion ? "unsupported transport, field or variable" : "invalid server configuration"}`,
        });
      }
    }
  } catch {
    diagnostics.push({ code: "CODEX_COMPANION_INVALID", message: ".mcp.json: invalid or inaccessible companion" });
  }
  try {
    const apps = await readCompanion(rootPath, ".app.json");
    if (apps !== undefined) {
      if (!isRecord(apps) || !isRecord(apps.apps)) throw new Error("invalid apps");
      diagnostics.push({
        code: "CODEX_COMPANION_UNSUPPORTED",
        message: ".app.json: Desktop has no Codex connector authorization API",
      });
    }
  } catch {
    diagnostics.push({ code: "CODEX_COMPANION_INVALID", message: ".app.json: invalid or inaccessible companion" });
  }
  if (
    manifest.hooks !== undefined ||
    (await exists(join(rootPath, "hooks.json"))) ||
    (await exists(join(rootPath, "hooks")))
  ) {
    diagnostics.push({
      code: "CODEX_COMPANION_UNSUPPORTED",
      message: "hooks: Codex hook execution is not supported by Desktop",
    });
  }
  resources.fingerprint = createHash("sha256").update(JSON.stringify({ resources, hashes, diagnostics })).digest("hex");
  return { resources, diagnostics };
}

/** Rechecked before execution so replaced symlinks cannot redirect approved paths. */
export async function resolveCodexCompanionPath(root: string, path: string): Promise<string> {
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).includes(".."))
    throw new Error("Invalid companion path");
  const canonicalRoot = await realpath(root);
  const canonical = await realpath(join(canonicalRoot, path));
  const within = relative(canonicalRoot, canonical);
  if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`))
    throw new Error("Companion escapes plugin root");
  return canonical;
}

async function collectFiles(root: string, directory: string, seen = new Set<string>()): Promise<string[]> {
  const canonical = await resolveCodexCompanionPath(root, directory);
  if (seen.has(canonical)) throw new Error("Companion directory cycle");
  seen.add(canonical);
  const files: string[] = [];
  for (const name of (await readdir(canonical)).sort()) {
    const path = join(directory, name);
    const target = await resolveCodexCompanionPath(root, path);
    const info = await stat(target);
    if (info.isDirectory()) files.push(...(await collectFiles(root, path, seen)));
    else if (info.isFile()) files.push(path);
    else throw new Error("Unsupported companion file");
  }
  return files;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function readCompanion(root: string, name: string): Promise<unknown> {
  if (!(await exists(join(root, name)))) return undefined;
  const path = await resolveCodexCompanionPath(root, name);
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

class UnsupportedCompanion extends Error {}

async function parseServer(value: unknown, root: string): Promise<CodexMcpServer> {
  if (!isRecord(value)) throw new Error("Invalid server");
  const type = value.type ?? (value.command !== undefined ? "stdio" : "http");
  const fields = type === "stdio" ? ["type", "command", "args", "env", "cwd"] : ["type", "url", "headers"];
  if ((type !== "stdio" && type !== "http") || Object.keys(value).some((key) => !fields.includes(key)))
    throw new UnsupportedCompanion();
  if (type === "http") {
    if (typeof value.url !== "string") throw new Error("Invalid URL");
    const url = new URL(value.url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash)
      throw new Error("Invalid URL");
    const headers = stringRecord(value.headers ?? {}, root);
    new Headers(headers);
    return { type, url: url.href, headers };
  }
  if (typeof value.command !== "string" || !value.command.trim()) throw new Error("Invalid command");
  const command = expand(value.command, root);
  const args = value.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error("Invalid arguments");
  if (value.cwd !== undefined && typeof value.cwd !== "string") throw new Error("Invalid cwd");
  const requestedCwd = value.cwd === undefined ? root : expand(value.cwd as string, root);
  const cwd = await resolveCodexCompanionPath(
    root,
    isAbsolute(requestedCwd) ? relative(root, requestedCwd) : requestedCwd,
  );
  if (!(await stat(cwd)).isDirectory()) throw new Error("Invalid cwd");
  return {
    type,
    command: command.startsWith("./") ? await resolveCodexCompanionPath(root, command) : command,
    args: args.map((arg: string) => expand(arg, root)),
    env: stringRecord(value.env ?? {}, root),
    cwd,
  };
}

function stringRecord(value: unknown, root: string): Record<string, string> {
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string"))
    throw new Error("Invalid string map");
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item as string, root)]));
}

function expand(value: string, root: string): string {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Codex manifest placeholder, not JavaScript interpolation.
  const expanded = value.replaceAll("${CODEX_PLUGIN_ROOT}", root);
  if (expanded.includes("${")) throw new UnsupportedCompanion();
  return expanded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
