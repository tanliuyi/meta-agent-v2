import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type RuntimeCompatibility,
  SIDECAR_PROTOCOL_VERSION,
  type SidecarRole,
} from "../../shared/sidecar-contracts.ts";
import { currentRuntimeCompatibility } from "../../shared/sidecar-wire.ts";

const SIDECAR_ROLES = ["thread", "metadata"] as const satisfies readonly SidecarRole[];

export interface SidecarRuntimeManifest {
  protocolVersion: typeof SIDECAR_PROTOCOL_VERSION;
  entries: Record<SidecarRole, string>;
  compatibility: RuntimeCompatibility;
  integrity: {
    entries: Record<SidecarRole, string>;
    files: Record<string, string>;
  };
}

export function loadSidecarRuntimeManifest(options: {
  isPackaged: boolean;
  resourcesPath: string;
  appDir: string;
}): SidecarRuntimeManifest {
  const manifestPath = options.isPackaged
    ? join(options.resourcesPath, "pi-sidecar", "runtime-manifest.json")
    : resolve(options.appDir, "../sidecar/runtime-manifest.json");
  const root = dirname(manifestPath);
  const parsed = parseManifest(manifestPath);
  const manifest: SidecarRuntimeManifest = {
    ...parsed,
    entries: Object.fromEntries(SIDECAR_ROLES.map((role) => [role, resolve(root, parsed.entries[role])])) as Record<
      SidecarRole,
      string
    >,
  };

  for (const role of SIDECAR_ROLES) {
    assertFile(manifest.entries[role], `${role} sidecar entry`, manifest.integrity.entries[role]);
  }
  for (const [path, hash] of Object.entries(manifest.integrity.files)) {
    assertFile(resolve(root, path), `Sidecar runtime file ${path}`, hash);
  }
  assertCurrentRuntimeCompatibility(manifest.compatibility);
  return manifest;
}

function parseManifest(manifestPath: string): SidecarRuntimeManifest {
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid sidecar runtime manifest: ${manifestPath}`);
  }
  const record = parsed as Record<string, unknown>;
  if ("nodePath" in record || "npmCliPath" in record) {
    throw new Error(`Legacy external Node fields are not allowed in the sidecar runtime manifest: ${manifestPath}`);
  }
  const entries = record.entries;
  const compatibility = record.compatibility;
  const integrity = record.integrity;
  if (
    typeof entries !== "object" ||
    entries === null ||
    Array.isArray(entries) ||
    typeof compatibility !== "object" ||
    compatibility === null ||
    Array.isArray(compatibility) ||
    typeof integrity !== "object" ||
    integrity === null ||
    Array.isArray(integrity)
  ) {
    throw new Error(`Invalid sidecar runtime manifest: ${manifestPath}`);
  }
  const entryRecord = entries as Record<string, unknown>;
  const integrityRecord = integrity as Record<string, unknown>;
  const integrityEntries = integrityRecord.entries;
  const files = integrityRecord.files;
  if (record.protocolVersion !== SIDECAR_PROTOCOL_VERSION) {
    throw new Error(
      `Sidecar runtime manifest protocol mismatch: expected ${SIDECAR_PROTOCOL_VERSION}, got ${String(record.protocolVersion)}`,
    );
  }
  if (
    typeof integrityEntries !== "object" ||
    integrityEntries === null ||
    Array.isArray(integrityEntries) ||
    typeof files !== "object" ||
    files === null ||
    Array.isArray(files) ||
    !SIDECAR_ROLES.every(
      (role) =>
        typeof entryRecord[role] === "string" &&
        typeof (integrityEntries as Record<string, unknown>)[role] === "string",
    ) ||
    !Object.entries(files).every(([path, hash]) => path.length > 0 && typeof hash === "string")
  ) {
    throw new Error(`Invalid sidecar runtime manifest integrity: ${manifestPath}`);
  }
  return parsed as SidecarRuntimeManifest;
}

function assertCurrentRuntimeCompatibility(expected: RuntimeCompatibility): void {
  const actual = currentRuntimeCompatibility(expected.runtimeCompatibilityId);
  for (const field of [
    "nodeVersion",
    "modulesAbi",
    "napi",
    "platform",
    "arch",
    "osRelease",
    "libc",
    "toolchain",
  ] as const) {
    if (expected[field] !== actual[field]) {
      throw new Error(
        `Sidecar runtime compatibility mismatch for ${field}: expected ${expected[field]}, got ${actual[field]}`,
      );
    }
  }
}

function assertFile(path: string, description: string, expectedHash: string): void {
  assertRealFilesystemPath(path, description);
  const stats = statSync(path);
  if (!stats.isFile()) throw new Error(`${description} is not a file: ${path}`);
  const actualHash = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error(`${description} integrity mismatch: expected ${expectedHash}, got ${actualHash}`);
  }
}

function assertRealFilesystemPath(path: string, description: string): void {
  if (/[\\/]app\.asar(?:[\\/]|$)/i.test(path)) {
    throw new Error(`${description} must be outside app.asar: ${path}`);
  }
}
