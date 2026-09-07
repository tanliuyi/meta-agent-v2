import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isCodexMarketplaceName, isCodexPluginName } from "./codex-plugin-identifiers.ts";

/**
 * Codex Marketplace JSON contract layer: typed model, strict parser and the
 * default personal Marketplace path resolution.
 *
 * The shape mirrors installed Codex Marketplace files: top-level `name`,
 * optional `interface.displayName` and an ordered `plugins` array. Entries
 * declare a local source (`source: "local"` plus a relative `path`) or a
 * remote source (`source: "url"` plus a URL), an optional `policy` block and
 * an optional display `interface`. Unknown fields are tolerated so future
 * Codex Marketplace additions keep parsing; known fields are type-checked
 * strictly and local paths must stay relative to the Marketplace root.
 */

export const CODEX_MARKETPLACE_INSTALLATION_POLICIES = ["NOT_AVAILABLE", "AVAILABLE", "INSTALLED_BY_DEFAULT"] as const;
export type CodexMarketplaceInstallationPolicy = (typeof CODEX_MARKETPLACE_INSTALLATION_POLICIES)[number];

export const CODEX_MARKETPLACE_AUTHENTICATION_POLICIES = ["ON_INSTALL", "ON_USE"] as const;
export type CodexMarketplaceAuthenticationPolicy = (typeof CODEX_MARKETPLACE_AUTHENTICATION_POLICIES)[number];

export interface CodexMarketplacePluginSource {
  source: string;
  /** Local source path, relative to the Marketplace root. */
  path?: string;
  /** Remote source URL (e.g. a git repository). */
  url?: string;
}

export interface CodexMarketplacePluginPolicy {
  installation?: CodexMarketplaceInstallationPolicy;
  authentication?: CodexMarketplaceAuthenticationPolicy;
  products?: string[];
}

export interface CodexMarketplacePluginEntryInterface {
  displayName?: string;
}

export interface CodexMarketplacePluginEntry {
  name: string;
  source: CodexMarketplacePluginSource;
  policy?: CodexMarketplacePluginPolicy;
  category?: string;
  interface?: CodexMarketplacePluginEntryInterface;
}

export interface CodexMarketplace {
  name: string;
  interface?: { displayName?: string };
  /** Ordered plugin entries; this order determines render order. */
  plugins: CodexMarketplacePluginEntry[];
}

export interface CodexMarketplaceValidationIssue {
  /** JSON-ish path into the Marketplace file, e.g. `$.plugins[0].policy`. */
  path: string;
  message: string;
}

export interface CodexMarketplaceParseResult {
  marketplace?: CodexMarketplace;
  issues: CodexMarketplaceValidationIssue[];
}

export function parseCodexMarketplace(jsonText: string): CodexMarketplaceParseResult {
  const issues: CodexMarketplaceValidationIssue[] = [];
  let rawValue: unknown;
  try {
    rawValue = JSON.parse(jsonText);
  } catch {
    return { issues: [{ path: "$", message: "must be valid JSON" }] };
  }
  if (!isObject(rawValue)) {
    return { issues: [{ path: "$", message: "must contain a JSON object" }] };
  }
  const raw = rawValue;
  const name = requireString(raw, "name", "$.name", issues);
  if (name !== undefined && !isCodexMarketplaceName(name)) {
    issues.push({ path: "$.name", message: "must match `[A-Za-z0-9_-]+`" });
  }
  const interfaceValue =
    raw.interface === undefined ? undefined : validateInterface(raw.interface, "$.interface", issues);
  const plugins = validatePlugins(raw.plugins, issues);
  if (name === undefined) return { issues };
  const marketplace: CodexMarketplace = { name, plugins };
  if (interfaceValue !== undefined) marketplace.interface = interfaceValue;
  return { marketplace, issues };
}

/**
 * Resolves the default personal Marketplace file under the user profile:
 * `<profile>\.agents\plugins\marketplace.json`. The default personal
 * Marketplace is discovered implicitly by Codex; other Marketplace files are
 * not.
 */
export function resolvePersonalMarketplacePath(homeDir: string = homedir()): string {
  return join(homeDir, ".agents", "plugins", "marketplace.json");
}

function validateInterface(
  rawValue: unknown,
  issuePath: string,
  issues: CodexMarketplaceValidationIssue[],
): { displayName?: string } | undefined {
  if (!isObject(rawValue)) {
    issues.push({ path: issuePath, message: "must be an object" });
    return undefined;
  }
  const displayName = rawValue.displayName;
  if (displayName !== undefined && (typeof displayName !== "string" || displayName.trim() === "")) {
    issues.push({ path: `${issuePath}.displayName`, message: "must be a non-empty string" });
  }
  const result: { displayName?: string } = {};
  const displayNameValue = typeof displayName === "string" && displayName.trim() !== "" ? displayName : undefined;
  if (displayNameValue !== undefined) result.displayName = displayNameValue;
  return result;
}

function validatePlugins(rawValue: unknown, issues: CodexMarketplaceValidationIssue[]): CodexMarketplacePluginEntry[] {
  if (!Array.isArray(rawValue)) {
    issues.push({ path: "$.plugins", message: "must be an array" });
    return [];
  }
  const plugins: CodexMarketplacePluginEntry[] = [];
  const names = new Set<string>();
  for (const [index, rawEntry] of rawValue.entries()) {
    const entry = validateEntry(rawEntry, `$.plugins[${index}]`, issues);
    if (entry === undefined) continue;
    if (names.has(entry.name)) {
      issues.push({ path: `$.plugins[${index}].name`, message: "duplicate plugin name" });
      continue;
    }
    names.add(entry.name);
    plugins.push(entry);
  }
  return plugins;
}

function validateEntry(
  rawValue: unknown,
  issuePath: string,
  issues: CodexMarketplaceValidationIssue[],
): CodexMarketplacePluginEntry | undefined {
  if (!isObject(rawValue)) {
    issues.push({ path: issuePath, message: "must be an object" });
    return undefined;
  }
  const raw = rawValue;
  const name = requireString(raw, "name", `${issuePath}.name`, issues);
  if (name !== undefined && !isCodexPluginName(name)) {
    issues.push({ path: `${issuePath}.name`, message: "must match `[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)*`" });
  }
  const source = validateSource(raw.source, `${issuePath}.source`, issues);
  const policy = raw.policy === undefined ? undefined : validatePolicy(raw.policy, `${issuePath}.policy`, issues);
  const category = raw.category;
  if (category !== undefined && (typeof category !== "string" || category.trim() === "")) {
    issues.push({ path: `${issuePath}.category`, message: "must be a non-empty string" });
  }
  const entryInterface =
    raw.interface === undefined ? undefined : validateInterface(raw.interface, `${issuePath}.interface`, issues);
  if (name === undefined || source === undefined) return undefined;
  const entry: CodexMarketplacePluginEntry = { name, source };
  if (policy !== undefined) entry.policy = policy;
  if (typeof category === "string" && category.trim() !== "") entry.category = category;
  if (entryInterface !== undefined) entry.interface = entryInterface;
  return entry;
}

function validateSource(
  rawValue: unknown,
  issuePath: string,
  issues: CodexMarketplaceValidationIssue[],
): CodexMarketplacePluginSource | undefined {
  if (!isObject(rawValue)) {
    issues.push({ path: issuePath, message: "must be an object" });
    return undefined;
  }
  const raw = rawValue;
  const source = requireString(raw, "source", `${issuePath}.source`, issues);
  const path = raw.path;
  let pathSafe = false;
  if (path !== undefined) {
    if (typeof path !== "string" || path.trim() === "" || !isSafeLocalSourcePath(path)) {
      issues.push({ path: `${issuePath}.path`, message: "must be a non-empty relative path" });
    } else {
      pathSafe = true;
    }
  }
  const url = raw.url;
  if (url !== undefined && (typeof url !== "string" || url.trim() === "")) {
    issues.push({ path: `${issuePath}.url`, message: "must be a non-empty string" });
  }
  if (path === undefined && url === undefined) {
    issues.push({ path: issuePath, message: "must declare a local `path` or a `url`" });
  }
  if (source === undefined) return undefined;
  const result: CodexMarketplacePluginSource = { source };
  // Keep the declared path verbatim; only safety is validated.
  if (pathSafe && typeof path === "string") result.path = path;
  if (typeof url === "string" && url.trim() !== "") result.url = url;
  return result;
}

function validatePolicy(
  rawValue: unknown,
  issuePath: string,
  issues: CodexMarketplaceValidationIssue[],
): CodexMarketplacePluginPolicy | undefined {
  if (!isObject(rawValue)) {
    issues.push({ path: issuePath, message: "must be an object" });
    return undefined;
  }
  const raw = rawValue;
  const installation = raw.installation;
  if (
    installation !== undefined &&
    !CODEX_MARKETPLACE_INSTALLATION_POLICIES.includes(installation as CodexMarketplaceInstallationPolicy)
  ) {
    issues.push({
      path: `${issuePath}.installation`,
      message: "must be one of `NOT_AVAILABLE`, `AVAILABLE`, `INSTALLED_BY_DEFAULT`",
    });
  }
  const authentication = raw.authentication;
  if (
    authentication !== undefined &&
    !CODEX_MARKETPLACE_AUTHENTICATION_POLICIES.includes(authentication as CodexMarketplaceAuthenticationPolicy)
  ) {
    issues.push({ path: `${issuePath}.authentication`, message: "must be one of `ON_INSTALL`, `ON_USE`" });
  }
  const products = raw.products;
  if (
    products !== undefined &&
    (!Array.isArray(products) || !products.every((item) => typeof item === "string" && item.trim() !== ""))
  ) {
    issues.push({ path: `${issuePath}.products`, message: "must be an array of strings" });
  }
  const result: CodexMarketplacePluginPolicy = {};
  if (
    typeof installation === "string" &&
    CODEX_MARKETPLACE_INSTALLATION_POLICIES.includes(installation as CodexMarketplaceInstallationPolicy)
  ) {
    result.installation = installation as CodexMarketplaceInstallationPolicy;
  }
  if (
    typeof authentication === "string" &&
    CODEX_MARKETPLACE_AUTHENTICATION_POLICIES.includes(authentication as CodexMarketplaceAuthenticationPolicy)
  ) {
    result.authentication = authentication as CodexMarketplaceAuthenticationPolicy;
  }
  if (Array.isArray(products) && products.every((item) => typeof item === "string" && item.trim() !== "")) {
    result.products = [...products];
  }
  return result;
}

/**
 * Resolves the marketplace root for a marketplace file. The Codex layout
 * places the file at `<root>/.agents/plugins/marketplace.json`, so the root is
 * three directories up: `~/.agents/plugins/marketplace.json` maps to `~` and
 * a repo marketplace to the repository root.
 */
export function resolveCodexMarketplaceRoot(marketplaceFilePath: string): string {
  return dirname(dirname(dirname(marketplaceFilePath)));
}

/**
 * Normalizes a local plugin source path (as declared in marketplace.json) to a
 * relative POSIX path, or undefined when it is absolute, empty, or traverses
 * outside the marketplace root. The declared text is not rewritten elsewhere;
 * this is the only place a safe path is converted for filesystem use.
 */
export function normalizeCodexLocalPluginPath(raw: string): string | undefined {
  if (!isSafeLocalSourcePath(raw)) return undefined;
  return raw
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
}

/** Checks a local source path for traversal or absolute escapes; the declared text is kept verbatim. */
function isSafeLocalSourcePath(raw: string): boolean {
  const posix = raw.replace(/\\/g, "/");
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) return false;
  const parts = posix.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0) return false;
  return !parts.some((part) => part === "..");
}

function requireString(
  raw: Record<string, unknown>,
  key: string,
  issuePath: string,
  issues: CodexMarketplaceValidationIssue[],
): string | undefined {
  const value = raw[key];
  if (typeof value === "string" && value.trim() !== "") return value;
  issues.push({ path: issuePath, message: "must be a non-empty string" });
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
