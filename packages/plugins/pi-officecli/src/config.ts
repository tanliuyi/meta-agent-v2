import { homedir } from "node:os";
import path from "node:path";
import type { OfficeCliConfig, ResolvedOfficeCliConfig } from "./types.ts";

/** Default release tag; bumped when a newer version has been verified. */
export const DEFAULT_VERSION = "v1.0.143";

export function resolveConfig(
  raw: Readonly<Record<string, string | number | boolean>> | undefined,
): ResolvedOfficeCliConfig {
  const binaryPath =
    typeof raw?.binaryPath === "string" && raw.binaryPath.trim() ? raw.binaryPath.trim() : "";
  const version =
    typeof raw?.version === "string" && raw.version.trim()
      ? raw.version.trim().replace(/^v?/, "v")
      : DEFAULT_VERSION;
  const autoDownload = raw?.autoDownload !== false;
  const dataDir =
    typeof raw?.dataDir === "string" && raw.dataDir.trim()
      ? raw.dataDir.trim()
      : path.join(homedir(), ".pi", "agent", "officecli");
  return { binaryPath, version, autoDownload, dataDir };
}

