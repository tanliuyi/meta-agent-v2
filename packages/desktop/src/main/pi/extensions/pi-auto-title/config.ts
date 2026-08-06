/**
 * Configuration loading for the pi-auto-title extension.
 *
 * Reads `agentDir/auto-title-config.json` (the same file the Desktop settings
 * UI writes through AutoTitleSettingsService). Missing or malformed values
 * fall back to defaults so the extension never fails to load.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  type AutoTitleSettings,
  defaultAutoTitleSettings,
  normalizeAutoTitleSettings,
} from "../../../../shared/auto-title-contracts.ts";

export function resolveAgentDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".pi", "agent");
}

export function resolveAutoTitleConfigPath(agentDir = resolveAgentDir()): string {
  return path.join(agentDir, "auto-title-config.json");
}

export function loadAutoTitleConfig(configPath = resolveAutoTitleConfigPath()): AutoTitleSettings {
  const settings = defaultAutoTitleSettings();
  try {
    if (fs.existsSync(configPath)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const data = parsed as Record<string, unknown>;
        if (typeof data.enabled === "boolean") settings.enabled = data.enabled;
        if (typeof data.providerId === "string") settings.providerId = data.providerId.trim();
        if (typeof data.modelId === "string") settings.modelId = data.modelId.trim();
        if (typeof data.systemPrompt === "string" && data.systemPrompt.trim().length > 0) {
          settings.systemPrompt = data.systemPrompt.trim();
        }
        if (typeof data.maxLength === "number" && Number.isFinite(data.maxLength)) {
          settings.maxLength = Math.floor(data.maxLength);
        }
        return normalizeAutoTitleSettings(settings);
      }
    }
  } catch {
    // Fall back to defaults on parse errors or access issues.
  }
  return settings;
}
