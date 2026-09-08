import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { isPathWithin } from "../../path-identity.ts";
import {
  type CodexMarketplaceAuthenticationPolicy,
  type CodexMarketplaceInstallationPolicy,
  normalizeCodexLocalPluginPath,
  parseCodexMarketplace,
  resolveCodexMarketplaceRoot,
  resolvePersonalMarketplacePath,
} from "./codex-marketplace.ts";
import { loadCodexPluginManifest } from "./codex-plugin-manifest.ts";

/**
 * Codex plugin source discovery: scans the default personal Marketplace and
 * validates every local `source.path` plugin root. This is the Codex-side
 * "the same local plugin root is discovered by Codex and Desktop" contract:
 * Desktop reads exactly the files the Codex host resolves, without accepting
 * remote-only entries.
 *
 * Repo/team Marketplace files are not implicitly discovered by Codex either;
 * they can be scanned through `discoverCodexPluginSourcesFromMarketplace`
 * once a caller supplies the explicit file path (Phase 3+).
 */

export interface CodexPluginSourceRecord {
  /** Codex plugin name, matching the plugin root directory and manifest. */
  name: string;
  version: string;
  /** Marketplace interface display name, falling back to the plugin name. */
  displayName: string;
  /** Manifest interface display name, falling back to the plugin name. */
  manifestDisplayName?: string;
  /** Absolute plugin root path (realpath-resolved where possible). */
  rootPath: string;
  /** Marketplace file the entry was declared in. */
  marketplacePath: string;
  /** Declared local source path, relative to the marketplace root. */
  sourcePath: string;
  marketplaceCategory?: string;
  installationPolicy?: CodexMarketplaceInstallationPolicy;
  authenticationPolicy?: CodexMarketplaceAuthenticationPolicy;
  products?: string[];
}

export type CodexPluginSourceIssueCode =
  | "marketplace.read-failed"
  | "marketplace.invalid"
  | "source.unsafe"
  | "source.missing"
  | "plugin.invalid"
  | "plugin.legacy-layout";

export interface CodexPluginSourceIssue {
  code: CodexPluginSourceIssueCode;
  /** Marketplace file the issue belongs to, when known. */
  marketplacePath?: string;
  /** Plugin name from the marketplace entry, when known. */
  pluginName?: string;
  message: string;
}

export interface CodexPluginSourcesResult {
  plugins: CodexPluginSourceRecord[];
  issues: CodexPluginSourceIssue[];
}

/**
 * Discovers Codex plugins from the default personal Marketplace under
 * `<homeDir>/.agents/plugins/marketplace.json`. A missing Marketplace file is
 * a normal state, not an issue.
 */
export async function discoverCodexPluginSources(homeDir: string): Promise<CodexPluginSourcesResult> {
  return discoverCodexPluginSourcesFromMarketplace(resolvePersonalMarketplacePath(homeDir));
}

/** Discovers Codex plugins from one explicit Marketplace file. */
export async function discoverCodexPluginSourcesFromMarketplace(
  marketplacePath: string,
): Promise<CodexPluginSourcesResult> {
  const issues: CodexPluginSourceIssue[] = [];
  const plugins: CodexPluginSourceRecord[] = [];
  let jsonText: string;
  try {
    const info = await lstat(marketplacePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      issues.push({
        code: "marketplace.read-failed",
        marketplacePath,
        message: "Marketplace file is not a regular file",
      });
      return { plugins, issues };
    }
    jsonText = await readFile(marketplacePath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { plugins, issues };
    issues.push({
      code: "marketplace.read-failed",
      marketplacePath,
      message: `Failed to read Marketplace file: ${errorMessage(error)}`,
    });
    return { plugins, issues };
  }
  const parsed = parseCodexMarketplace(jsonText);
  const marketplace = parsed.marketplace;
  for (const issue of parsed.issues) {
    issues.push({
      code: "marketplace.invalid",
      marketplacePath,
      message: `${issue.path}: ${issue.message}`,
    });
  }
  if (marketplace === undefined) return { plugins, issues };
  let canonicalMarketplaceRoot: string;
  try {
    canonicalMarketplaceRoot = await realpath(resolveCodexMarketplaceRoot(marketplacePath));
  } catch {
    issues.push({ code: "marketplace.read-failed", marketplacePath, message: "Marketplace root is not accessible" });
    return { plugins, issues };
  }
  const marketplaceRoot = resolveCodexMarketplaceRoot(marketplacePath);
  for (const entry of marketplace.plugins) {
    if (entry.source.source !== "local") continue; // remote sources need installation (Phase 3)
    const sourcePath = normalizeCodexLocalPluginPath(entry.source.path ?? "");
    if (sourcePath === undefined) {
      issues.push({
        code: "source.unsafe",
        marketplacePath,
        pluginName: entry.name,
        message: `Entry source path \`${entry.source.path ?? ""}\` is absolute or escapes the marketplace root`,
      });
      continue;
    }
    const rootPath = resolve(marketplaceRoot, sourcePath);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(rootPath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        issues.push({
          code: "source.missing",
          marketplacePath,
          pluginName: entry.name,
          message: `Plugin root does not exist: ${rootPath}`,
        });
        continue;
      }
      issues.push({
        code: "source.missing",
        marketplacePath,
        pluginName: entry.name,
        message: `Plugin root is not accessible: ${rootPath}`,
      });
      continue;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      issues.push({
        code: "source.missing",
        marketplacePath,
        pluginName: entry.name,
        message: `Plugin root is not a directory: ${rootPath}`,
      });
      continue;
    }
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(rootPath);
    } catch {
      issues.push({
        code: "source.missing",
        marketplacePath,
        pluginName: entry.name,
        message: `Plugin root is not accessible: ${rootPath}`,
      });
      continue;
    }
    if (!isPathWithin(canonicalMarketplaceRoot, canonicalRoot)) {
      issues.push({
        code: "source.unsafe",
        marketplacePath,
        pluginName: entry.name,
        message: "Plugin root escapes the Marketplace root",
      });
      continue;
    }
    if (basename(canonicalRoot) !== entry.name) {
      issues.push({
        code: "plugin.invalid",
        marketplacePath,
        pluginName: entry.name,
        message: "Plugin directory name does not match the Marketplace entry name",
      });
      continue;
    }
    const loaded = await loadCodexPluginManifest(canonicalRoot);
    if (loaded.manifest === undefined) {
      const detail = loaded.issues[0] ? `: ${loaded.issues[0].path}: ${loaded.issues[0].message}` : "";
      issues.push({
        code: "plugin.invalid",
        marketplacePath,
        pluginName: entry.name,
        message: `Plugin manifest is invalid${detail}`,
      });
      continue;
    }
    if (loaded.manifest.name !== entry.name) {
      issues.push({
        code: "plugin.invalid",
        marketplacePath,
        pluginName: entry.name,
        message: `Manifest name \`${loaded.manifest.name}\` does not match the Marketplace entry name \`${entry.name}\``,
      });
      continue;
    }
    if (await fileExists(join(canonicalRoot, "market-manifest.json"))) {
      issues.push({
        code: "plugin.legacy-layout",
        marketplacePath,
        pluginName: entry.name,
        message: "Legacy market-manifest.json layout is not a Codex plugin",
      });
      continue;
    }
    const manifestDisplayName = loaded.manifest.interface?.displayName;
    plugins.push({
      name: loaded.manifest.name,
      version: loaded.manifest.version,
      displayName: entry.interface?.displayName ?? manifestDisplayName ?? entry.name,
      ...(manifestDisplayName !== undefined ? { manifestDisplayName } : {}),
      rootPath: canonicalRoot,
      marketplacePath,
      sourcePath,
      ...(entry.category ? { marketplaceCategory: entry.category } : {}),
      ...(entry.policy?.installation ? { installationPolicy: entry.policy.installation } : {}),
      ...(entry.policy?.authentication ? { authenticationPolicy: entry.policy.authentication } : {}),
      ...(entry.policy?.products ? { products: [...entry.policy.products] } : {}),
    });
  }
  return { plugins, issues };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
