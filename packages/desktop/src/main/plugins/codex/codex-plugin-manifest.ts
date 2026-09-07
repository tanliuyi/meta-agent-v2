import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { valid } from "semver";
import { isCodexPluginName } from "./codex-plugin-identifiers.ts";

/**
 * Codex plugin contract layer: typed model, strict parser and on-disk validation
 * for `.codex-plugin/plugin.json`.
 *
 * The contract mirrors manifests accepted by the installed Codex host (observed
 * from real plugin layouts, e.g. dart-flutter, browser, codex-app-tools):
 * `name`, `version`, `description` and `author.name` are required; everything
 * else is optional, including `interface`. Unknown top-level fields are tolerated
 * (real hosts accept e.g. `bundledContentVariant` and `hooks`), but every known
 * field is type-checked strictly and all paths must stay inside the plugin root.
 */

export interface CodexPluginAuthor {
  name: string;
  email?: string;
  url?: string;
}

export interface CodexPluginInterface {
  displayName?: string;
  shortDescription?: string;
  longDescription?: string;
  developerName?: string;
  category?: string;
  capabilities?: string[];
  websiteURL?: string;
  privacyPolicyURL?: string;
  termsOfServiceURL?: string;
  brandColor?: string;
  composerIcon?: string;
  logo?: string;
  logoDark?: string;
  screenshots?: string[];
  defaultPrompt?: string[];
}

export interface CodexPluginManifest {
  id?: string;
  name: string;
  version: string;
  description: string;
  author: CodexPluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  skills?: string;
  apps?: string;
  mcpServers?: string | Record<string, unknown>;
  /** Opaque hook declarations; supported hook forms are validated in Phase 4. */
  hooks?: unknown;
  interface?: CodexPluginInterface;
}

export interface CodexPluginValidationIssue {
  /** JSON-ish path into the manifest, e.g. `$.interface.brandColor`. */
  path: string;
  message: string;
}

export interface CodexPluginManifestParseResult {
  manifest?: CodexPluginManifest;
  issues: CodexPluginValidationIssue[];
}

export interface CodexPluginManifestLoadResult {
  manifest?: CodexPluginManifest;
  issues: CodexPluginValidationIssue[];
}

const TODO_MARKER = "[TODO:";
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const HTTPS_SCHEME = "https:";

/** Companion targets a contract path field may resolve to. */
const COMPANION_TARGETS: Record<string, string> = {
  skills: "skills",
  apps: ".app.json",
  mcpServers: ".mcp.json",
};

export function parseCodexPluginManifest(jsonText: string): CodexPluginManifestParseResult {
  const issues: CodexPluginValidationIssue[] = [];
  const raw = parseJsonObject(jsonText, "$", issues);
  if (raw === undefined) return { issues };
  rejectTodoMarkers(raw, "$", issues);
  const manifest = validateManifestShape(raw, issues);
  if (manifest === undefined || issues.length > 0) return { issues };
  return { manifest, issues };
}

/**
 * Reads and validates a plugin manifest plus its on-disk companions and asset
 * references. Never mutates the manifest; invalid manifests fail with stable,
 * user-facing diagnostics.
 */
export async function loadCodexPluginManifest(pluginRoot: string): Promise<CodexPluginManifestLoadResult> {
  const issues: CodexPluginValidationIssue[] = [];
  const manifestPath = join(pluginRoot, ".codex-plugin", "plugin.json");
  let jsonText: string;
  try {
    jsonText = await readFile(manifestPath, "utf8");
  } catch {
    return { issues: [{ path: "$", message: "missing `.codex-plugin/plugin.json`" }] };
  }
  const parsed = parseCodexPluginManifest(jsonText);
  const manifest = parsed.manifest;
  issues.push(...parsed.issues);
  if (manifest === undefined) return { issues };
  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(pluginRoot);
  } catch {
    issues.push({ path: "$", message: "plugin root is not accessible" });
    return { issues };
  }
  await validateOnDiskCompanions(resolvedRoot, pluginRoot, manifest, issues);
  if (issues.length > 0) return { issues };
  return { manifest, issues };
}

function validateManifestShape(
  raw: Record<string, unknown>,
  issues: CodexPluginValidationIssue[],
): CodexPluginManifest | undefined {
  const name = requireString(raw, "name", "$.name", issues);
  const version = requireString(raw, "version", "$.version", issues);
  const description = requireString(raw, "description", "$.description", issues);
  if (name !== undefined && !isCodexPluginName(name)) {
    issues.push({ path: "$.name", message: "must match `[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)*`" });
  }
  if (version !== undefined && valid(version) === null) {
    issues.push({ path: "$.version", message: "must be strict semver" });
  }
  const author = validateAuthor(raw, issues);
  validateOptionalString(raw, "id", "$.id", issues);
  for (const field of ["homepage", "repository", "license"]) {
    validateOptionalString(raw, field, `$.${field}`, issues);
  }
  validateStringArray(raw, "keywords", "$.keywords", issues);
  for (const [field, expected] of Object.entries(COMPANION_TARGETS)) {
    if (field === "mcpServers" && typeof raw[field] !== "string") continue;
    validateContractPath(raw, field, expected, `$.${field}`, issues);
  }
  if (raw.mcpServers !== undefined && typeof raw.mcpServers !== "string") {
    validateMcpServerEntries(raw.mcpServers, "$.mcpServers", issues);
  }
  const interfaceValue = raw.interface === undefined ? undefined : validateInterface(raw.interface, issues);
  if (name === undefined || version === undefined || description === undefined || author === undefined) {
    return undefined;
  }
  const manifest: CodexPluginManifest = {
    name,
    version,
    description,
    author,
    ...copyOptionalStrings(raw, ["id", "homepage", "repository", "license"]),
    ...copyOptionalRaw(raw, ["hooks"]),
  };
  const keywords = optionalStringArray(raw.keywords);
  if (keywords !== undefined) manifest.keywords = keywords;
  if (typeof raw.skills === "string") manifest.skills = raw.skills;
  if (typeof raw.apps === "string") manifest.apps = raw.apps;
  if (typeof raw.mcpServers === "string") {
    manifest.mcpServers = raw.mcpServers;
  } else if (isObject(raw.mcpServers)) {
    manifest.mcpServers = raw.mcpServers;
  }
  if (interfaceValue !== undefined) manifest.interface = interfaceValue;
  return manifest;
}

function validateAuthor(
  raw: Record<string, unknown>,
  issues: CodexPluginValidationIssue[],
): CodexPluginAuthor | undefined {
  const author = raw.author;
  if (!isObject(author)) {
    issues.push({ path: "$.author", message: "must be an object" });
    return undefined;
  }
  const name = requireString(author, "name", "$.author.name", issues);
  validateOptionalString(author, "email", "$.author.email", issues);
  validateOptionalHttpsUrl(author, "url", "$.author.url", issues);
  if (name === undefined) return undefined;
  return { name, ...copyOptionalStrings(author, ["email", "url"]) };
}

function validateInterface(rawValue: unknown, issues: CodexPluginValidationIssue[]): CodexPluginInterface | undefined {
  if (!isObject(rawValue)) {
    issues.push({ path: "$.interface", message: "must be an object" });
    return undefined;
  }
  for (const field of ["displayName", "shortDescription", "longDescription", "developerName", "category"]) {
    validateOptionalString(rawValue, field, `$.interface.${field}`, issues);
  }
  validateStringArray(rawValue, "capabilities", "$.interface.capabilities", issues);
  validateStringArray(rawValue, "defaultPrompt", "$.interface.defaultPrompt", issues);
  for (const field of ["websiteURL", "privacyPolicyURL", "termsOfServiceURL"]) {
    validateOptionalHttpsUrl(rawValue, field, `$.interface.${field}`, issues);
  }
  if (rawValue.brandColor !== undefined) {
    if (typeof rawValue.brandColor !== "string" || !HEX_COLOR_PATTERN.test(rawValue.brandColor)) {
      issues.push({ path: "$.interface.brandColor", message: "must use `#RRGGBB`" });
    }
  }
  for (const field of ["composerIcon", "logo", "logoDark"]) {
    validateAssetPathSyntax(rawValue, field, `$.interface.${field}`, issues);
  }
  validateAssetPathArray(rawValue.screenshots, "$.interface.screenshots", issues);
  const result: CodexPluginInterface = {};
  for (const field of [
    "displayName",
    "shortDescription",
    "longDescription",
    "developerName",
    "category",
    "websiteURL",
    "privacyPolicyURL",
    "termsOfServiceURL",
    "brandColor",
    "composerIcon",
    "logo",
    "logoDark",
  ]) {
    const value = optionalString(rawValue[field]);
    if (value !== undefined) result[field] = value;
  }
  const capabilities = optionalStringArray(rawValue.capabilities);
  if (capabilities !== undefined) result.capabilities = capabilities;
  const screenshots = optionalStringArray(rawValue.screenshots);
  if (screenshots !== undefined) result.screenshots = screenshots;
  const defaultPrompt = optionalStringArray(rawValue.defaultPrompt);
  if (defaultPrompt !== undefined) result.defaultPrompt = defaultPrompt;
  return result;
}

async function validateOnDiskCompanions(
  resolvedRoot: string,
  pluginRoot: string,
  manifest: CodexPluginManifest,
  issues: CodexPluginValidationIssue[],
): Promise<void> {
  if (manifest.skills !== undefined) {
    await validateSkillsDirectory(resolvedRoot, pluginRoot, issues);
  }
  if (manifest.apps !== undefined) {
    await validateCompanionJson(resolvedRoot, pluginRoot, ".app.json", "$.apps", issues);
  }
  if (typeof manifest.mcpServers === "string") {
    await validateCompanionJson(resolvedRoot, pluginRoot, ".mcp.json", "$.mcpServers", issues);
  }
  for (const field of ["composerIcon", "logo", "logoDark"] as const) {
    const asset = manifest.interface?.[field];
    if (asset !== undefined) await validateAssetFile(resolvedRoot, pluginRoot, asset, `$.interface.${field}`, issues);
  }
  for (const [index, screenshot] of (manifest.interface?.screenshots ?? []).entries()) {
    await validateAssetFile(resolvedRoot, pluginRoot, screenshot, `$.interface.screenshots[${index}]`, issues);
  }
}

/**
 * Resolves a plugin-relative path and verifies it stays inside the plugin
 * root. All path containment checks run on `realpath` results so symlinks and
 * junctions cannot smuggle a path outside the archive.
 */
async function resolveInsidePluginRoot(
  resolvedRoot: string,
  pluginRoot: string,
  relativePath: string,
): Promise<ResolvedPluginPath> {
  let resolvedCandidate: string;
  try {
    resolvedCandidate = await realpath(join(pluginRoot, relativePath));
  } catch {
    return { kind: "missing" };
  }
  if (!isContainedIn(resolvedRoot, resolvedCandidate)) return { kind: "escape" };
  return { kind: "resolved", resolved: resolvedCandidate };
}

function isContainedIn(resolvedRoot: string, resolvedCandidate: string): boolean {
  const relativePath = relative(resolvedRoot, resolvedCandidate);
  return !isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`);
}

async function validateSkillsDirectory(
  resolvedRoot: string,
  pluginRoot: string,
  issues: CodexPluginValidationIssue[],
): Promise<void> {
  const pathResult = await resolveInsidePluginRoot(resolvedRoot, pluginRoot, "skills");
  if (pathResult.kind === "escape") {
    issues.push({ path: "$.skills", message: "must stay inside the plugin archive" });
    return;
  }
  if (pathResult.kind === "missing" || !(await isDirectory(pathResult.resolved))) {
    issues.push({ path: "$.skills", message: "companion directory `skills` is missing" });
  }
}

type ResolvedPluginPath = { kind: "resolved"; resolved: string } | { kind: "missing" } | { kind: "escape" };

async function validateCompanionJson(
  resolvedRoot: string,
  pluginRoot: string,
  fileName: string,
  issuePath: string,
  issues: CodexPluginValidationIssue[],
): Promise<void> {
  const pathResult = await resolveInsidePluginRoot(resolvedRoot, pluginRoot, fileName);
  if (pathResult.kind === "missing") {
    issues.push({ path: issuePath, message: `companion file \`${fileName}\` is missing` });
    return;
  }
  if (pathResult.kind === "escape") {
    issues.push({ path: issuePath, message: "must stay inside the plugin archive" });
    return;
  }
  let jsonText: string;
  try {
    jsonText = await readFile(pathResult.resolved, "utf8");
  } catch {
    issues.push({ path: issuePath, message: `companion file \`${fileName}\` is missing` });
    return;
  }
  parseJsonObject(jsonText, issuePath, issues);
}

async function validateAssetFile(
  resolvedRoot: string,
  pluginRoot: string,
  rawPath: string,
  issuePath: string,
  issues: CodexPluginValidationIssue[],
): Promise<void> {
  const parts = normalizeAssetParts(rawPath);
  if (parts === undefined) return; // syntax issue already reported at parse time
  const pathResult = await resolveInsidePluginRoot(resolvedRoot, pluginRoot, join(...parts));
  if (pathResult.kind === "missing") {
    issues.push({ path: issuePath, message: "points to a missing file" });
    return;
  }
  if (pathResult.kind === "escape") {
    issues.push({ path: issuePath, message: "must stay inside the plugin archive" });
    return;
  }
  if (!(await isFile(pathResult.resolved))) {
    issues.push({ path: issuePath, message: "must reference a regular file" });
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function validateContractPath(
  raw: Record<string, unknown>,
  key: string,
  expected: string,
  issuePath: string,
  issues: CodexPluginValidationIssue[],
): void {
  const value = raw[key];
  if (value === undefined) return;
  if (typeof value !== "string" || value.trim() === "") {
    issues.push({ path: issuePath, message: "must be a non-empty path" });
    return;
  }
  const normalized = normalizeContractPath(value);
  if (normalized === undefined) {
    issues.push({ path: issuePath, message: "must be a relative path" });
    return;
  }
  if (normalized !== expected) {
    issues.push({ path: issuePath, message: `must resolve to \`${expected}\`` });
  }
}

/** Normalizes a contract path like the Codex validator; undefined for absolute paths. */
function normalizeContractPath(raw: string): string | undefined {
  const posix = raw.replace(/\\/g, "/");
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) return undefined;
  return posix
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
}

function validateMcpServerEntries(value: unknown, issuePath: string, issues: CodexPluginValidationIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: issuePath, message: "must be a string path or object" });
    return;
  }
  for (const [name, server] of Object.entries(value)) {
    if (name.trim() === "") {
      issues.push({ path: issuePath, message: "server names must be non-empty strings" });
    }
    if (!isObject(server)) {
      issues.push({ path: `${issuePath}.${name}`, message: "must be an object" });
    }
  }
}

function validateAssetPathSyntax(
  raw: Record<string, unknown>,
  key: string,
  issuePath: string,
  issues: CodexPluginValidationIssue[],
): void {
  const value = raw[key];
  if (value === undefined) return;
  if (typeof value !== "string" || value.trim() === "" || normalizeAssetParts(value) === undefined) {
    issues.push({ path: issuePath, message: "must be a non-empty relative path inside the plugin archive" });
  }
}

function validateAssetPathArray(value: unknown, issuePath: string, issues: CodexPluginValidationIssue[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.push({ path: issuePath, message: "must be an array of relative paths" });
    return;
  }
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.trim() === "" || normalizeAssetParts(item) === undefined) {
      issues.push({
        path: `${issuePath}[${index}]`,
        message: "must be a non-empty relative path inside the plugin archive",
      });
    }
  }
}

/** Splits an asset path into safe relative parts, or undefined when it escapes the plugin root. */
function normalizeAssetParts(raw: string): string[] | undefined {
  const posix = raw.replace(/\\/g, "/");
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) return undefined;
  const parts = posix.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) return undefined;
  return parts;
}

function validateOptionalHttpsUrl(
  raw: Record<string, unknown>,
  key: string,
  issuePath: string,
  issues: CodexPluginValidationIssue[],
): void {
  const value = raw[key];
  if (value === undefined) return;
  if (typeof value !== "string" || !isAbsoluteHttpsUrl(value)) {
    issues.push({ path: issuePath, message: "must be an absolute `https://` URL" });
  }
}

function isAbsoluteHttpsUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === HTTPS_SCHEME && parsed.host !== "";
}

function validateOptionalString(
  raw: Record<string, unknown>,
  key: string,
  issuePath: string,
  issues: CodexPluginValidationIssue[],
): void {
  const value = raw[key];
  if (value === undefined) return;
  if (typeof value !== "string" || value.trim() === "") {
    issues.push({ path: issuePath, message: "must be a non-empty string" });
  }
}

function requireString(
  raw: Record<string, unknown>,
  key: string,
  issuePath: string,
  issues: CodexPluginValidationIssue[],
): string | undefined {
  const value = raw[key];
  if (typeof value === "string" && value.trim() !== "") return value;
  issues.push({ path: issuePath, message: "must be a non-empty string" });
  return undefined;
}

function validateStringArray(
  raw: Record<string, unknown>,
  key: string,
  issuePath: string,
  issues: CodexPluginValidationIssue[],
): void {
  const value = raw[key];
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim() !== "")) {
    issues.push({ path: issuePath, message: "must be an array of strings" });
  }
}

function rejectTodoMarkers(value: unknown, path: string, issues: CodexPluginValidationIssue[]): void {
  if (typeof value === "string") {
    if (value.includes(TODO_MARKER)) {
      issues.push({ path, message: "must not contain a `[TODO: ...]` placeholder" });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) rejectTodoMarkers(item, `${path}[${index}]`, issues);
    return;
  }
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) rejectTodoMarkers(item, `${path}.${key}`, issues);
  }
}

function parseJsonObject(
  jsonText: string,
  path: string,
  issues: CodexPluginValidationIssue[],
): Record<string, unknown> | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    issues.push({ path, message: "must be valid JSON" });
    return undefined;
  }
  if (!isObject(raw)) {
    issues.push({ path, message: "must contain a JSON object" });
    return undefined;
  }
  return raw;
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim() !== "")
    ? [...value]
    : undefined;
}

function copyOptionalStrings(raw: Record<string, unknown>, fields: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of fields) {
    const value = optionalString(raw[field]);
    if (value !== undefined) result[field] = value;
  }
  return result;
}

function copyOptionalRaw(raw: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (raw[field] !== undefined) result[field] = raw[field];
  }
  return result;
}
