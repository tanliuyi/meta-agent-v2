import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { InlineExtension, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import {
  DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
  type DesktopExtensionDiagnostic,
  type ResolvedExtensionSet,
} from "../../shared/desktop-extension-contracts.ts";

export async function validateResolvedExtensionSet(
  projectId: string,
  set: ResolvedExtensionSet,
): Promise<ResolvedExtensionSet> {
  if (!set || set.projectId !== projectId || !set.generation) {
    throw new Error(`Resolved extension set does not match project ${projectId}`);
  }
  const ids = new Set<string>();
  for (const entry of set.entries) {
    if (!entry.id || ids.has(entry.id)) throw new Error(`Duplicate or empty Desktop extension ID: ${entry.id}`);
    ids.add(entry.id);
    if (entry.hostProfileVersion !== DESKTOP_EXTENSION_HOST_PROFILE_VERSION) {
      throw new Error(`Unsupported Desktop extension host profile for ${entry.id}`);
    }
    if (entry.source === "builtin") {
      if (entry.entryPath) throw new Error(`Built-in extension ${entry.id} must use an inline factory`);
      continue;
    }
    if (!entry.entryPath || !isAbsolute(entry.entryPath)) {
      throw new Error(`Extension ${entry.id} requires an absolute approved entry path`);
    }
    if (!entry.contentHash) throw new Error(`Extension ${entry.id} requires a resolved content hash`);
    const info = await lstat(entry.entryPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Extension ${entry.id} entry is not a regular non-symlink file`);
    }
    const currentHash = createHash("sha256")
      .update(await readFile(entry.entryPath))
      .digest("hex");
    if (currentHash !== entry.contentHash) {
      throw new Error(`Extension ${entry.id} changed after its set was resolved`);
    }
    if (entry.source === "curated") {
      if (!set.curatedRoot) throw new Error(`Curated extension root is unavailable for ${entry.id}`);
      const canonicalRoot = await realpath(set.curatedRoot);
      const canonicalEntry = await realpath(entry.entryPath);
      const withinRoot = relative(canonicalRoot, canonicalEntry);
      if (withinRoot.startsWith("..") || isAbsolute(withinRoot)) {
        throw new Error(`Curated extension escapes bundled root: ${entry.id}`);
      }
    }
  }
  return {
    ...set,
    entries: set.entries.map((entry) => ({
      ...entry,
      ...(entry.entryPath ? { entryPath: resolve(entry.entryPath) } : {}),
      capabilities: [...entry.capabilities],
    })),
    diagnostics: set.diagnostics.map((diagnostic) => ({ ...diagnostic })),
  };
}

export function controlledResourceLoaderOptions(set: ResolvedExtensionSet, extensionFactories: InlineExtension[]) {
  return {
    noExtensions: true,
    additionalExtensionPaths: set.entries.flatMap((entry) => (entry.entryPath ? [entry.entryPath] : [])),
    extensionFactories,
    packageManagerOnMissing: async () => "error" as const,
  };
}

export function extensionServiceDiagnostics(
  set: ResolvedExtensionSet,
  diagnostics: Array<{ type: string; message: string }>,
): DesktopExtensionDiagnostic[] {
  return diagnostics.flatMap((diagnostic) => {
    if (diagnostic.type !== "error" || !diagnostic.message.startsWith('Extension "')) return [];
    const extensionPath = diagnostic.message.match(/^Extension "([^"]+)"/)?.[1];
    const entry = set.entries.find(
      (candidate) =>
        candidate.entryPath === extensionPath ||
        (extensionPath !== undefined &&
          (extensionPath.includes(candidate.id) || extensionPath.includes(candidate.displayName))),
    );
    return [
      {
        extensionId: entry?.id ?? "unknown",
        source: entry?.source ?? "builtin",
        extensionSetGeneration: set.generation,
        projectId: set.projectId,
        phase: "register" as const,
        code: "DESKTOP_EXTENSION_REGISTRATION_FAILED",
        message: sanitizeExtensionMessage(diagnostic.message, extensionPath, entry?.displayName),
      },
    ];
  });
}

export function extensionLoadDiagnostics(
  set: ResolvedExtensionSet,
  result: Pick<LoadExtensionsResult, "errors">,
): DesktopExtensionDiagnostic[] {
  const diagnostics = set.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    extensionSetGeneration: set.generation,
    projectId: set.projectId,
  }));
  for (const error of result.errors ?? []) {
    const normalized = resolve(error.path);
    const entry = set.entries.find((candidate) => candidate.entryPath && resolve(candidate.entryPath) === normalized);
    diagnostics.push({
      extensionId: entry?.id ?? "unknown",
      source: entry?.source ?? "development",
      extensionSetGeneration: set.generation,
      projectId: set.projectId,
      phase: "load",
      code: "DESKTOP_EXTENSION_LOAD_FAILED",
      message: sanitizeExtensionMessage(error.error, error.path, entry?.displayName),
    });
  }
  return diagnostics;
}

export function sanitizeExtensionMessage(
  message: string,
  privatePath: string | undefined,
  displayName: string | undefined,
): string {
  if (!privatePath) return displayName ? `${displayName}: extension operation failed` : "Extension operation failed";
  return message.split(privatePath).join(displayName ?? "approved extension");
}
