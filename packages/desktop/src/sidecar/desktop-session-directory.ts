import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { GENERAL_WORKSPACE_ID } from "../shared/contracts.ts";

const GENERAL_SESSION_DIRECTORY_NAME = "--general--";

export function resolveDesktopSessionDirectory(projectId: string, agentDir: string): string | undefined {
  return projectId === GENERAL_WORKSPACE_ID
    ? join(resolve(agentDir), "sessions", GENERAL_SESSION_DIRECTORY_NAME)
    : undefined;
}

export function resolveLegacyGeneralSessionDirectory(cwd: string, agentDir: string): string {
  const resolvedCwd = resolve(cwd);
  const legacyName = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolve(agentDir), "sessions", legacyName);
}

export function remapLegacyGeneralSessionPath(projectId: string, cwd: string, agentDir: string, path: string): string {
  const target = resolveDesktopSessionDirectory(projectId, agentDir);
  if (!target) return path;
  return rebasePath(path, resolveLegacyGeneralSessionDirectory(cwd, agentDir), target);
}

export function migrateLegacyGeneralSessionDirectory(projectId: string, cwd: string, agentDir: string): void {
  const target = resolveDesktopSessionDirectory(projectId, agentDir);
  if (!target) return;
  const source = resolveLegacyGeneralSessionDirectory(cwd, agentDir);
  if (source === target || !existsSync(source)) return;

  rewriteParentSessionPaths(source, source, target);
  mkdirSync(join(resolve(agentDir), "sessions"), { recursive: true });
  if (!existsSync(target)) {
    renameSync(source, target);
    return;
  }

  const names = readdirSync(source);
  const conflict = names.find((name) => existsSync(join(target, name)));
  if (conflict) throw new Error(`Cannot migrate general sessions because the target already contains ${conflict}`);
  for (const name of names) renameSync(join(source, name), join(target, name));
  rmdirSync(source);
}

function rewriteParentSessionPaths(directory: string, source: string, target: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      rewriteParentSessionPaths(path, source, target);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const content = readFileSync(path, "utf8");
    const newline = content.indexOf("\n");
    const firstLine = newline === -1 ? content : content.slice(0, newline);
    let header: unknown;
    try {
      header = JSON.parse(firstLine);
    } catch {
      continue;
    }
    if (!isRecord(header) || header.type !== "session") continue;
    let changed = false;
    for (const field of ["parentSession", "branchedFrom"] as const) {
      const value = header[field];
      if (typeof value !== "string") continue;
      const remapped = rebasePath(value, source, target);
      if (remapped === value) continue;
      header[field] = remapped;
      changed = true;
    }
    if (!changed) continue;
    const remainder = newline === -1 ? "" : content.slice(newline);
    const temporary = `${path}.${process.pid}.migration.tmp`;
    writeFileSync(temporary, `${JSON.stringify(header)}${remainder}`, { flag: "wx" });
    renameSync(temporary, path);
  }
}

function rebasePath(path: string, source: string, target: string): string {
  const suffix = relative(source, resolve(path));
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) return path;
  return join(target, suffix);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
