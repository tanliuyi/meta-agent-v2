import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { GENERAL_WORKSPACE_ID, type Project } from "../../shared/contracts.ts";
import type {
  MemoryEntryCollection,
  MemoryEntryTarget,
  MemoryMaintenanceResult,
  MemoryMutationResult,
  MemoryProjectSummary,
  MemorySettings,
  MemorySettingsSnapshot,
  MemorySkillSummary,
  MutateMemoryEntryInput,
  RunMemoryMaintenanceInput,
  SaveMemorySettingsInput,
  SaveMemorySettingsResult,
} from "../../shared/memory-settings-contracts.ts";
import { validateMemorySettings } from "../../shared/memory-settings-contracts.ts";
import { loadConfig } from "../pi/extensions/pi-hermes-memory/config.ts";
import { ENTRY_DELIMITER } from "../pi/extensions/pi-hermes-memory/constants.ts";
import {
  isSafeProjectName as isSafeProjectNameWithinRoot,
  resolveAuthoritativeMemoryFile,
  syncMarkdownMemoriesToSqlite,
} from "../pi/extensions/pi-hermes-memory/handlers/sync-markdown-memories.ts";
import { resolveGlobalMemoryRoot } from "../pi/extensions/pi-hermes-memory/paths.ts";
import { resolveMemoryPolicyPrompt } from "../pi/extensions/pi-hermes-memory/prompt-context.ts";
import { canonicalStoragePath } from "../pi/extensions/pi-hermes-memory/store/canonical-storage-path.ts";
import { DatabaseManager } from "../pi/extensions/pi-hermes-memory/store/db.ts";
import { MemoryStore } from "../pi/extensions/pi-hermes-memory/store/memory-store.ts";
import { getSessionStats, indexAllSessions } from "../pi/extensions/pi-hermes-memory/store/session-indexer.ts";
import { SkillStore } from "../pi/extensions/pi-hermes-memory/store/skill-store.ts";
import {
  reconcileMarkdownFailureScopes,
  reconcileMarkdownMemoryScope,
} from "../pi/extensions/pi-hermes-memory/store/sqlite-memory-store.ts";
import type { MemoryConfig, MemoryResult } from "../pi/extensions/pi-hermes-memory/types.ts";

export const MISSING_MEMORY_SETTINGS_REVISION = "missing:hermes-memory-config-v1";

const GENERAL_WORKSPACE_MEMORY_KEY = "__desktop_general_workspace__";

interface CurrentMemorySettingsSource {
  exists: boolean;
  revision: string;
  data: Record<string, unknown>;
}

interface MemorySettingsServiceOptions {
  createId?(): string;
  listProjects?(): Promise<Project[]>;
  getProjectCwd?(projectId: string): string;
}

/** Desktop-owned settings and maintenance surface for the built-in Hermes memory extension. */
export class MemorySettingsService {
  readonly path: string;
  private readonly agentDir: string;
  private readonly createId: () => string;
  private readonly listProjects: () => Promise<Project[]>;
  private readonly getProjectCwd: (projectId: string) => string;
  private saveTail: Promise<void> = Promise.resolve();

  constructor(agentDir: string, options: MemorySettingsServiceOptions = {}) {
    this.agentDir = resolve(agentDir);
    this.path = join(this.agentDir, "hermes-memory-config.json");
    this.createId = options.createId ?? randomUUID;
    this.listProjects = options.listProjects ?? (async () => []);
    this.getProjectCwd =
      options.getProjectCwd ??
      (() => {
        throw new Error("Desktop project lookup is unavailable");
      });
  }

  async getSnapshot(): Promise<MemorySettingsSnapshot> {
    return this.snapshotFromCurrent(await this.readCurrent());
  }

  saveConfig(input: SaveMemorySettingsInput): Promise<SaveMemorySettingsResult> {
    const operation = this.saveTail.then(() => this.saveConfigLocked(input));
    this.saveTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async mutateEntry(input: MutateMemoryEntryInput): Promise<MemoryMutationResult> {
    assertMutationInput(input);
    const current = await this.readCurrent();
    if (current.revision !== input.expectedRevision) {
      throw new Error("Memory settings changed on disk. Reload before editing memory entries.");
    }
    const config = loadConfig(this.path);
    const { store, target, projectMemoryKey } = await this.resolveStore(config, input.target, input.projectId);
    const database = new DatabaseManager(this.globalDir(config));
    store.setMutationObserver(async (mutatedTarget, entries) => {
      try {
        if (mutatedTarget === "failure") reconcileMarkdownFailureScopes(database, entries);
        else {
          reconcileMarkdownMemoryScope(
            database,
            entries,
            mutatedTarget,
            input.target === "project" ? (projectMemoryKey ?? null) : null,
          );
        }
        return null;
      } catch (error) {
        return `Saved to Markdown, but SQLite search reconciliation failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    });

    let result: MemoryResult;
    try {
      await store.loadFromDisk();
      if (input.action === "add") {
        result = await store.add(target, input.content!);
      } else {
        const rawEntry = store.getRawEntriesForSync(target).find((entry) => memoryEntryId(entry) === input.entryId);
        if (!rawEntry) {
          result = { success: false, error: "The selected memory entry changed. Reload and try again." };
        } else if (input.action === "replace") {
          result = await store.replaceExact(target, rawEntry, input.content!);
        } else {
          result = await store.removeExact(target, rawEntry);
        }
      }
    } finally {
      database.close();
    }

    const snapshotResult = await this.tryGetSnapshot();
    return {
      success: result.success,
      message: result.message,
      warning: result.warning ?? snapshotResult.warning,
      error: result.error,
      snapshot: snapshotResult.snapshot,
    };
  }

  async runMaintenance(input: RunMemoryMaintenanceInput): Promise<MemoryMaintenanceResult> {
    assertMaintenanceInput(input);
    const config = loadConfig(this.path);
    let message: string;
    let success: boolean;
    if (input.action === "index-sessions") {
      const database = new DatabaseManager(this.globalDir(config));
      try {
        const sessionsDir = process.env.PI_CODING_AGENT_SESSION_DIR?.trim() || join(this.agentDir, "sessions");
        const result = indexAllSessions(database, sessionsDir);
        const stats = getSessionStats(database);
        success = result.errors.length === 0;
        message = `已索引 ${result.sessionsIndexed} 个会话、${result.messagesIndexed} 条消息；数据库现有 ${stats.totalSessions} 个会话。`;
        if (result.errors.length > 0) message += ` ${result.errors.length} 个文件处理失败。`;
      } finally {
        database.close();
      }
    } else {
      const result = await this.syncMarkdown(config);
      success = result.warnings.length === 0;
      message = `已扫描 ${result.filesScanned} 个文件，导入 ${result.imported} 条，移除 ${result.removed} 条失效索引。`;
      if (result.warnings.length > 0) message += ` ${result.warnings.length} 个范围同步失败。`;
    }
    const snapshotResult = await this.tryGetSnapshot();
    if (snapshotResult.warning) message += ` ${snapshotResult.warning}`;
    return { success, message, snapshot: snapshotResult.snapshot };
  }

  private async saveConfigLocked(input: SaveMemorySettingsInput): Promise<SaveMemorySettingsResult> {
    assertSaveInput(input);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.path, {
      realpath: false,
      stale: 30_000,
      retries: { retries: 6, factor: 1.6, minTimeout: 50, maxTimeout: 500, randomize: true },
    });
    try {
      const current = await this.readCurrent();
      if (current.revision !== input.expectedRevision) {
        return { status: "conflict", current: await this.snapshotFromCurrent(current) };
      }
      const settings = input.settings;
      const currentSessionSearch = isPlainObject(current.data.sessionSearch) ? current.data.sessionSearch : {};
      const next = {
        ...current.data,
        memoryMode: settings.memoryMode,
        memoryPolicyStyle: settings.memoryPolicyStyle,
        memoryPolicyCustomText: settings.memoryPolicyCustomText,
        memoryCharLimit: settings.memoryCharLimit,
        userCharLimit: settings.userCharLimit,
        projectCharLimit: settings.projectCharLimit,
        reviewEnabled: settings.reviewEnabled,
        nudgeInterval: settings.nudgeInterval,
        nudgeToolCalls: settings.nudgeToolCalls,
        correctionDetection: settings.correctionDetection,
        flushOnCompact: settings.flushOnCompact,
        flushOnShutdown: settings.flushOnShutdown,
        flushMinTurns: settings.flushMinTurns,
        memoryOverflowStrategy: settings.memoryOverflowStrategy,
        autoConsolidate: settings.memoryOverflowStrategy === "auto-consolidate",
        sessionSearch: { ...currentSessionSearch, variant: settings.sessionSearchVariant },
      };
      await this.atomicWrite(`${JSON.stringify(next, null, 2)}\n`);
      const snapshotResult = await this.tryGetSnapshot();
      return { status: "saved", snapshot: snapshotResult.snapshot, warning: snapshotResult.warning };
    } finally {
      await release();
    }
  }

  private async snapshotFromCurrent(current: CurrentMemorySettingsSource): Promise<MemorySettingsSnapshot> {
    const config = loadConfig(this.path);
    const globalStore = new MemoryStore({ ...config, memoryDir: this.globalDir(config) });
    const projectsAndSkillsPromise = this.loadProjectsAndSkills(config);
    const globalSkillsPromise = new SkillStore({ globalSkillsDir: join(this.globalDir(config), "skills") }).loadIndex(
      "global",
    );
    const [, { projects, projectCollections, skills }, globalSkills] = await Promise.all([
      globalStore.loadFromDisk(),
      projectsAndSkillsPromise,
      globalSkillsPromise,
    ]);
    const collections: MemoryEntryCollection[] = [
      collection(
        "memory",
        globalStore.getRawEntriesForSync("memory"),
        globalStore.getMemoryEntries(),
        config.memoryCharLimit,
      ),
      collection("user", globalStore.getRawEntriesForSync("user"), globalStore.getUserEntries(), config.userCharLimit),
      collection(
        "failure",
        globalStore.getRawEntriesForSync("failure"),
        globalStore.getAllFailureEntries(),
        config.memoryCharLimit * 2,
      ),
      ...projectCollections,
    ];
    skills.unshift(...globalSkills.map(toSkillSummary));
    const contextPreview =
      config.memoryMode === "policy-only"
        ? (resolveMemoryPolicyPrompt(config) ?? "")
        : globalStore.formatForSystemPrompt();
    return {
      path: this.path,
      exists: current.exists,
      revision: current.revision,
      settings: settingsFromConfig(config),
      collections,
      projects,
      skills,
      contextPreview,
    };
  }

  private async loadProjectsAndSkills(config: MemoryConfig): Promise<{
    projects: MemoryProjectSummary[];
    projectCollections: MemoryEntryCollection[];
    skills: MemorySkillSummary[];
  }> {
    const projectsRoot = this.projectsRoot(config);
    const catalogProjects = await this.listProjects();
    const loadedProjects = await Promise.all(
      catalogProjects.map(async (project) => {
        const memoryKey = resolveProjectMemoryKey(project.id, project.cwd);
        if (
          (project.id !== GENERAL_WORKSPACE_ID && memoryKey === GENERAL_WORKSPACE_MEMORY_KEY) ||
          !isSafeProjectNameWithinRoot(memoryKey, projectsRoot)
        ) {
          return {
            project: {
              id: project.id,
              name: project.name,
              memoryKey,
              available: project.available,
              issue: "项目目录无法映射到记忆存储",
              entryCount: 0,
              charCount: 0,
            },
            collection: collection("project", [], [], config.projectCharLimit, project.name, project.id),
            skills: [] as MemorySkillSummary[],
          };
        }
        const memoryFile = resolveAuthoritativeMemoryFile(projectsRoot, memoryKey);
        if (!memoryFile) {
          return {
            project: {
              id: project.id,
              name: project.name,
              memoryKey,
              available: project.available,
              issue: "项目记忆目录是符号链接，已拒绝读取",
              entryCount: 0,
              charCount: 0,
            },
            collection: collection("project", [], [], config.projectCharLimit, project.name, project.id),
            skills: [] as MemorySkillSummary[],
          };
        }
        const memoryDir = dirname(memoryFile);
        try {
          const info = await lstat(memoryDir);
          if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("项目记忆路径不是普通目录");
        } catch (error) {
          if (!isNodeError(error, "ENOENT")) throw error;
          return {
            project: {
              id: project.id,
              name: project.name,
              memoryKey,
              available: project.available,
              issue: project.issue,
              entryCount: 0,
              charCount: 0,
            },
            collection: collection("project", [], [], config.projectCharLimit, project.name, project.id),
            skills: [] as MemorySkillSummary[],
          };
        }
        const store = new MemoryStore({ ...config, memoryCharLimit: config.projectCharLimit, memoryDir });
        const projectSkillsPromise = new SkillStore({
          globalSkillsDir: join(this.globalDir(config), "skills"),
          projectSkillsDir: join(memoryDir, "skills"),
          projectName: project.name,
        }).loadIndex("project");
        const [, projectSkills] = await Promise.all([store.loadFromDisk(), projectSkillsPromise]);
        const entries = store.getMemoryEntries();
        const item = collection(
          "project",
          store.getRawEntriesForSync("memory"),
          entries,
          config.projectCharLimit,
          project.name,
          project.id,
        );
        return {
          project: {
            id: project.id,
            name: project.name,
            memoryKey,
            available: project.available,
            issue: project.issue,
            entryCount: entries.length,
            charCount: item.charCount,
          },
          collection: item,
          skills: projectSkills.map(toSkillSummary),
        };
      }),
    );
    const projects: MemoryProjectSummary[] = [];
    const projectCollections: MemoryEntryCollection[] = [];
    const skills: MemorySkillSummary[] = [];
    for (const loaded of loadedProjects) {
      if (!loaded) continue;
      projects.push(loaded.project);
      projectCollections.push(loaded.collection);
      skills.push(...loaded.skills);
    }
    return { projects, projectCollections, skills };
  }

  private async resolveStore(
    config: MemoryConfig,
    target: MemoryEntryTarget,
    projectId: string | undefined,
  ): Promise<{
    store: MemoryStore;
    target: "memory" | "user" | "failure";
    projectMemoryKey?: string;
  }> {
    if (target !== "project") {
      return { store: new MemoryStore({ ...config, memoryDir: this.globalDir(config) }), target };
    }
    if (!projectId) throw new TypeError("A Desktop project ID is required");
    const projectsRoot = this.projectsRoot(config);
    const projectMemoryKey = resolveProjectMemoryKey(projectId, this.getProjectCwd(projectId));
    if (
      (projectId !== GENERAL_WORKSPACE_ID && projectMemoryKey === GENERAL_WORKSPACE_MEMORY_KEY) ||
      !isSafeProjectNameWithinRoot(projectMemoryKey, projectsRoot)
    ) {
      throw new TypeError("The Desktop project cannot be mapped to memory storage");
    }
    const memoryFile = resolveAuthoritativeMemoryFile(projectsRoot, projectMemoryKey);
    if (!memoryFile) throw new Error("Project memory directory must not be a symlink");
    const store = new MemoryStore({
      ...config,
      memoryCharLimit: config.projectCharLimit,
      memoryDir: dirname(memoryFile),
    });
    const [canonicalRoot, storageIdentity] = await Promise.all([
      canonicalStoragePath(projectsRoot),
      store.getStorageIdentity("memory"),
    ]);
    const relativePath = relative(canonicalRoot, storageIdentity);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error("Project memory path escapes the configured projects directory");
    }
    return { store, target: "memory", projectMemoryKey };
  }

  private async syncMarkdown(config: MemoryConfig) {
    const database = new DatabaseManager(this.globalDir(config));
    try {
      return await syncMarkdownMemoriesToSqlite(
        database,
        this.globalDir(config),
        config.projectsMemoryDir,
        this.agentDir,
      );
    } finally {
      database.close();
    }
  }

  private globalDir(config: MemoryConfig): string {
    return resolveGlobalMemoryRoot(config.memoryDir, this.agentDir).globalDir;
  }

  private projectsRoot(config: MemoryConfig): string {
    return join(this.agentDir, config.projectsMemoryDir ?? "projects-memory");
  }

  private async tryGetSnapshot(): Promise<{ snapshot?: MemorySettingsSnapshot; warning?: string }> {
    try {
      return { snapshot: await this.getSnapshot() };
    } catch (error) {
      return {
        warning: `The operation completed, but memory data could not be reloaded: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async readCurrent(): Promise<CurrentMemorySettingsSource> {
    try {
      const info = await lstat(this.path);
      if (info.isSymbolicLink()) throw new Error(`Refusing to read symlink: ${this.path}`);
      if (!info.isFile()) throw new Error(`Hermes memory config is not a regular file: ${this.path}`);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return { exists: false, revision: MISSING_MEMORY_SETTINGS_REVISION, data: {} };
      }
      throw error;
    }
    const bytes = await readFile(this.path);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("hermes-memory-config.json JSON syntax invalid");
    }
    if (!isPlainObject(value)) throw new Error("hermes-memory-config.json must be a JSON object");
    return { exists: true, revision: createHash("sha256").update(bytes).digest("hex"), data: value };
  }

  private async atomicWrite(source: string): Promise<void> {
    const directory = dirname(this.path);
    const tempPath = join(directory, `.hermes-memory-config.json.${process.pid}.${this.createId()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(source, "utf8");
      await handle.sync();
      await handle.chmod(0o600);
      await handle.close();
      handle = undefined;
      await rename(tempPath, this.path);
      await chmod(this.path, 0o600).catch(() => undefined);
      if (process.platform !== "win32") {
        const directoryHandle = await open(directory, "r").catch(() => undefined);
        if (directoryHandle) {
          try {
            await directoryHandle.sync();
          } catch {
            // best-effort
          } finally {
            await directoryHandle.close().catch(() => undefined);
          }
        }
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

function settingsFromConfig(config: MemoryConfig): MemorySettings {
  return {
    memoryMode: config.memoryMode,
    memoryPolicyStyle: config.memoryPolicyStyle ?? "full",
    memoryPolicyCustomText: config.memoryPolicyCustomText ?? "",
    memoryCharLimit: config.memoryCharLimit,
    userCharLimit: config.userCharLimit,
    projectCharLimit: config.projectCharLimit,
    reviewEnabled: config.reviewEnabled,
    nudgeInterval: config.nudgeInterval,
    nudgeToolCalls: config.nudgeToolCalls,
    correctionDetection: config.correctionDetection,
    flushOnCompact: config.flushOnCompact,
    flushOnShutdown: config.flushOnShutdown,
    flushMinTurns: config.flushMinTurns,
    memoryOverflowStrategy: config.memoryOverflowStrategy ?? (config.autoConsolidate ? "auto-consolidate" : "reject"),
    sessionSearchVariant: config.sessionSearch?.variant ?? "legacy",
  };
}

function collection(
  target: MemoryEntryTarget,
  rawEntries: string[],
  visibleEntries: string[],
  charLimit: number,
  projectName?: string,
  projectId?: string,
): MemoryEntryCollection {
  return {
    target,
    ...(projectId ? { projectId } : {}),
    ...(projectName ? { projectName } : {}),
    entries: rawEntries.map((rawEntry, index) => ({
      id: memoryEntryId(rawEntry),
      content: visibleEntries[index] ?? rawEntry,
    })),
    charCount: rawEntries.length > 0 ? rawEntries.join(ENTRY_DELIMITER).length : 0,
    charLimit,
  };
}

function memoryEntryId(rawEntry: string): string {
  return createHash("sha256").update(rawEntry).digest("hex");
}

function toSkillSummary(skill: Awaited<ReturnType<SkillStore["loadIndex"]>>[number]): MemorySkillSummary {
  return {
    skillId: skill.skillId,
    scope: skill.scope,
    name: skill.name,
    displayName: skill.displayName,
    description: skill.description,
    projectName: skill.projectName,
  };
}

function assertSaveInput(input: SaveMemorySettingsInput): void {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.expectedRevision !== "string" ||
    !isPlainObject(input.settings) ||
    validateMemorySettings(input.settings as unknown as MemorySettings).length > 0
  ) {
    throw new TypeError("Invalid memory settings save input");
  }
}

function assertMutationInput(input: MutateMemoryEntryInput): void {
  const targets: readonly MemoryEntryTarget[] = ["memory", "user", "failure", "project"];
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.expectedRevision !== "string" ||
    !["add", "replace", "remove"].includes(input.action) ||
    !targets.includes(input.target) ||
    (input.target === "project" && typeof input.projectId !== "string") ||
    (input.action !== "remove" && (typeof input.content !== "string" || input.content.trim().length === 0)) ||
    (input.action !== "add" && (typeof input.entryId !== "string" || input.entryId.length === 0))
  ) {
    throw new TypeError("Invalid memory entry mutation input");
  }
}

function assertMaintenanceInput(input: RunMemoryMaintenanceInput): void {
  if (!input || typeof input !== "object" || !["index-sessions", "sync-markdown"].includes(input.action)) {
    throw new TypeError("Invalid memory maintenance input");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function resolveProjectMemoryKey(projectId: string, cwd: string): string {
  return projectId === GENERAL_WORKSPACE_ID ? GENERAL_WORKSPACE_MEMORY_KEY : basename(resolve(cwd));
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
