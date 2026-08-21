import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { applyEdits, modify, type ParseError, parse } from "jsonc-parser";
import lockfile from "proper-lockfile";

export interface BashShellConfig {
  shell: string;
  args: string[];
  commandTransport?: "argv" | "stdin";
}

export function getSystemPiShellPath(cwd: string, agentDir: string): string | undefined {
  const projectPath = join(resolve(cwd), ".pi", "settings.json");
  const project = readSettings(projectPath);
  if (typeof project.shellPath === "string" && project.shellPath.trim()) return project.shellPath;
  const global = readSettings(join(resolve(agentDir), "settings.json"));
  return typeof global.shellPath === "string" && global.shellPath.trim() ? global.shellPath : undefined;
}

export async function saveSystemPiShellPath(cwd: string, agentDir: string, shellPath: string): Promise<void> {
  if (!isAbsolute(shellPath)) throw new Error(`Shell path must be absolute: ${shellPath}`);
  const projectPath = join(resolve(cwd), ".pi", "settings.json");
  const projectSettings = readSettings(projectPath, true);
  const target = Object.hasOwn(projectSettings, "shellPath") ? projectPath : join(resolve(agentDir), "settings.json");
  mkdirSync(dirname(target), { recursive: true });
  const release = await lockfile.lock(target, {
    realpath: false,
    stale: 30_000,
    retries: { retries: 6, factor: 1.6, minTimeout: 50, maxTimeout: 500, randomize: true },
  });
  try {
    const source = existsSync(target) ? readFileSync(target, "utf8") : "{}\n";
    readSettings(target, true);
    const next = applyEdits(
      source,
      modify(source, ["shellPath"], shellPath, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
      }),
    );
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, next.endsWith("\n") ? next : `${next}\n`, { flag: "wx" });
    renameSync(temporary, target);
  } finally {
    await release();
  }
}

export function getBashShellConfig(customShellPath?: string): BashShellConfig {
  if (customShellPath) {
    if (!existsSync(customShellPath)) throw new Error(`Custom shell path not found: ${customShellPath}`);
    return bashConfig(customShellPath);
  }
  const candidates = process.platform === "win32" ? windowsBashCandidates() : ["/bin/bash"];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return bashConfig(candidate);
  }
  const fromPath = findBashOnPath();
  if (fromPath) return bashConfig(fromPath);
  if (process.platform !== "win32") return { shell: "sh", args: ["-c"] };
  throw new Error("No bash shell found");
}

function readSettings(path: string, strict = false): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const errors: ParseError[] = [];
    const value: unknown = parse(readFileSync(path, "utf8"), errors);
    if (strict && errors.length > 0) throw new Error(`Invalid system Pi settings: ${path}`);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch (error) {
    if (strict) throw error;
    return {};
  }
}

function bashConfig(shell: string): BashShellConfig {
  const normalized = shell.replace(/\//g, "\\").toLowerCase();
  return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized)
    ? { shell, args: ["-s"], commandTransport: "stdin" }
    : { shell, args: ["-c"] };
}

function windowsBashCandidates(): string[] {
  return [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
    .filter((root): root is string => Boolean(root))
    .map((root) => join(root, "Git", "bin", "bash.exe"));
}

function findBashOnPath(): string | undefined {
  const executable = process.platform === "win32" ? "bash.exe" : "bash";
  if (process.platform === "win32") {
    const result = spawnSync("where.exe", [executable], { encoding: "utf8", timeout: 5_000, windowsHide: true });
    return result.status === 0
      ? result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((path) => path && existsSync(path))
      : undefined;
  }
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (!entry) continue;
    const candidate = join(entry, executable);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
