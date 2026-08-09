import { promises as fs } from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { AdapterConfig } from "./config.ts";
import { debug } from "./log.ts";

/** User-facing config keys (subset of AdapterConfig). Loaded from
 *  ~/.<CONFIG_DIR_NAME>/acp.json (global) and <cwd>/.<CONFIG_DIR_NAME>/acp.json
 *  (project-local overrides project-global). Project wins over global. */
export interface UserAcpConfig {
  debug?: boolean;
  autoUpdate?: boolean;
  modelContextLimit?: number;
  toolBashDefaultTimeout?: number;
  toolOutputMaxBytes?: number;
}

/** Read global + project acp.json, project overrides global. Returns {} on any
 *  error (missing file, bad JSON) — never throws. */
export async function loadUserConfig(cwd: string): Promise<UserAcpConfig> {
  const home = homedir();
  const merged: UserAcpConfig = {};
  for (const base of [join(home, CONFIG_DIR_NAME), join(cwd, CONFIG_DIR_NAME)]) {
    const file = join(base, "acp.json");
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        Object.assign(merged, pickKnown(parsed));
        debug.event("config-loaded", { file });
      }
    } catch {
      // missing or unreadable — skip
    }
  }
  return merged;
}

function join(... parts: string[]): string {
  return path.join(...parts);
}

const KNOWN = new Set(["debug", "autoUpdate", "modelContextLimit", "toolBashDefaultTimeout", "toolOutputMaxBytes"]);

function pickKnown(parsed: Record<string, unknown>): UserAcpConfig {
  const out: UserAcpConfig = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (KNOWN.has(k)) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export type UserAcpConfigKey = keyof UserAcpConfig;

/** Merge user config onto an adapter config. Desktop host keys are protected
 * when passed in `protectedKeys`; standard Pi callers can omit that argument
 * and keep the legacy user-config precedence. */
export function applyUserConfig(
  adapter: AdapterConfig,
  user: UserAcpConfig,
  protectedKeys: ReadonlySet<UserAcpConfigKey> = new Set(),
): AdapterConfig {
  const next: AdapterConfig = {
    ...adapter,
    ...user,
    debug: protectedKeys.has("debug") ? adapter.debug : user.debug ?? adapter.debug,
    modelContextLimit: protectedKeys.has("modelContextLimit")
      ? adapter.modelContextLimit
      : user.modelContextLimit ?? adapter.modelContextLimit,
    toolBashDefaultTimeout: protectedKeys.has("toolBashDefaultTimeout")
      ? adapter.toolBashDefaultTimeout
      : user.toolBashDefaultTimeout ?? adapter.toolBashDefaultTimeout,
    toolOutputMaxBytes: protectedKeys.has("toolOutputMaxBytes")
      ? adapter.toolOutputMaxBytes
      : user.toolOutputMaxBytes ?? adapter.toolOutputMaxBytes,
    // A Desktop entry explicitly disables update checks; user config must not
    // turn runtime package replacement back on in that environment.
    autoUpdate: adapter.autoUpdate === false ? false : user.autoUpdate ?? adapter.autoUpdate,
    // coreOverrides / protectedTools / preserveRecentMessages are not overridable
    // from acp.json (keep them from the factory config).
    coreOverrides: adapter.coreOverrides,
    protectedTools: adapter.protectedTools,
    preserveRecentMessages: adapter.preserveRecentMessages,
  };
  return next;
}
