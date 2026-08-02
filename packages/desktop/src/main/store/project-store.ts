import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Project, WorkbenchState } from "../../shared/contracts.ts";
import { GENERAL_WORKSPACE_ID } from "../../shared/contracts.ts";

type ProjectStatus = "available" | "missing" | "permissionDenied" | "invalid";

interface StoredProject {
  projectId: string;
  name: string;
  path: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
  trust?: unknown;
}

interface ProjectMetadataFile {
  version: 1;
  projects: StoredProject[];
}

interface DesktopState {
  version: 1;
  activeProjectId?: string;
  archivedThreads: Record<string, string[]>;
  workbenches: Record<string, WorkbenchState>;
}

interface LegacyDesktopState extends DesktopState {
  projects?: Array<{ id: string; name: string; cwd: string; lastOpenedAt: number }>;
}

const EMPTY_PROJECTS: ProjectMetadataFile = { version: 1, projects: [] };
const EMPTY_DESKTOP_STATE: DesktopState = { version: 1, archivedThreads: {}, workbenches: {} };

/** 内部通用工作区的展示名。 */
const GENERAL_WORKSPACE_NAME = "对话";

/** 持久化 Pi-compatible Project metadata 与 Desktop 专属 UI 状态。 */
export class ProjectStore {
  private projectMetadata: ProjectMetadataFile = EMPTY_PROJECTS;
  private desktopState: DesktopState = EMPTY_DESKTOP_STATE;
  private readonly projectFile: string;
  private readonly desktopFile: string;
  private readonly generalWorkspaceCwd: string | undefined;
  private saveProjectsTask: Promise<void> = Promise.resolve();
  private saveDesktopTask: Promise<void> = Promise.resolve();

  constructor(
    desktopFile: string,
    projectFile = join(dirname(desktopFile), "projects.json"),
    generalWorkspaceCwd?: string,
  ) {
    this.desktopFile = desktopFile;
    this.projectFile = projectFile;
    this.generalWorkspaceCwd = generalWorkspaceCwd;
    if (generalWorkspaceCwd !== undefined) {
      if (!existsSync(generalWorkspaceCwd)) mkdirSync(generalWorkspaceCwd, { recursive: true });
    }
  }

  async load(): Promise<void> {
    const [desktop, projects] = await Promise.all([
      readOptionalJson(this.desktopFile),
      readOptionalJson(this.projectFile),
    ]);
    if (desktop === undefined) {
      this.desktopState = { ...EMPTY_DESKTOP_STATE, archivedThreads: {}, workbenches: {} };
    } else {
      if (!isDesktopState(desktop)) throw new Error("Desktop 状态文件格式无效");
      this.desktopState = {
        version: 1,
        activeProjectId: desktop.activeProjectId,
        archivedThreads: desktop.archivedThreads,
        workbenches: desktop.workbenches,
      };
    }

    if (projects !== undefined) {
      if (!isProjectMetadataFile(projects)) throw new Error("Project metadata 文件格式无效");
      this.projectMetadata = projects;
      return;
    }

    const legacy = desktop as LegacyDesktopState | undefined;
    if (legacy?.projects) {
      this.projectMetadata = {
        version: 1,
        projects: legacy.projects.map((project) => fromLegacyProject(project)),
      };
      await this.saveProjects();
      await this.saveDesktop();
      return;
    }
    this.projectMetadata = { ...EMPTY_PROJECTS, projects: [] };
  }

  /** 检查 projectId 是否合法：已存储的真实项目或已配置的通用工作区。 */
  private assertProjectAccessible(projectId: string): void {
    if (projectId === GENERAL_WORKSPACE_ID) {
      if (!this.generalWorkspaceCwd) throw new Error("通用工作区未初始化");
      return;
    }
    if (!this.projectMetadata.projects.some(({ projectId: id }) => id === projectId)) {
      throw new Error(`Project 不存在: ${projectId}`);
    }
  }

  private generalProject(): Project | null {
    if (!this.generalWorkspaceCwd) return null;
    return {
      id: GENERAL_WORKSPACE_ID,
      kind: "general",
      name: GENERAL_WORKSPACE_NAME,
      cwd: this.generalWorkspaceCwd,
      lastOpenedAt: 0,
      available: true,
    };
  }

  async list(): Promise<Project[]> {
    const projects = await Promise.all(this.projectMetadata.projects.map((project) => this.toProject(project)));
    const general = this.generalProject();
    return general ? [general, ...projects] : projects;
  }

  async getActive(): Promise<Project | null> {
    const activeId = this.desktopState.activeProjectId;
    if (activeId === GENERAL_WORKSPACE_ID) return this.generalProject();
    const project = this.projectMetadata.projects.find(({ projectId }) => projectId === activeId);
    return project ? this.toProject(project) : null;
  }

  async add(folder: string): Promise<Project> {
    const path = await normalizeDirectory(folder);
    let project = this.projectMetadata.projects.find((item) => samePath(item.path, path));
    if (!project) {
      const now = new Date().toISOString();
      project = {
        projectId: randomUUID(),
        name: basename(path),
        path,
        status: "available",
        createdAt: now,
        updatedAt: now,
        lastOpenedAt: now,
      };
      this.projectMetadata.projects.push(project);
    } else {
      project.lastOpenedAt = new Date().toISOString();
      project.updatedAt = project.lastOpenedAt;
      project.status = "available";
    }
    this.desktopState.activeProjectId = project.projectId;
    await Promise.all([this.saveProjects(), this.saveDesktop()]);
    return this.toProject(project);
  }

  async open(projectId: string): Promise<Project> {
    if (projectId === GENERAL_WORKSPACE_ID) {
      const descriptor = this.generalProject();
      if (!descriptor) throw new Error("通用工作区未初始化");
      this.desktopState.activeProjectId = projectId;
      await this.saveDesktop();
      return descriptor;
    }
    const project = this.requireStored(projectId);
    const result = await this.toProject(project);
    if (!result.available) throw new Error(result.issue ?? "Project 目录不可用");
    const now = new Date().toISOString();
    project.lastOpenedAt = now;
    project.updatedAt = now;
    project.status = "available";
    this.desktopState.activeProjectId = projectId;
    await Promise.all([this.saveProjects(), this.saveDesktop()]);
    return { ...result, lastOpenedAt: Date.parse(now) };
  }

  async rename(projectId: string, name: string): Promise<Project> {
    const project = this.requireStored(projectId);
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error("Project 名称不能为空");
    project.name = normalizedName;
    project.updatedAt = new Date().toISOString();
    await this.saveProjects();
    return this.toProject(project);
  }

  async remove(projectId: string): Promise<void> {
    if (projectId === GENERAL_WORKSPACE_ID) {
      throw new Error("不能删除内置通用工作区");
    }
    this.requireStored(projectId);
    this.projectMetadata.projects = this.projectMetadata.projects.filter(({ projectId: id }) => id !== projectId);
    await this.saveProjects();
  }

  getCwd(projectId: string): string {
    if (projectId === GENERAL_WORKSPACE_ID) {
      if (!this.generalWorkspaceCwd) throw new Error("通用工作区未初始化");
      return this.generalWorkspaceCwd;
    }
    return this.requireStored(projectId).path;
  }

  isArchived(projectId: string, threadId: string): boolean {
    this.assertProjectAccessible(projectId);
    return this.desktopState.archivedThreads[projectId]?.includes(threadId) ?? false;
  }

  async setArchived(projectId: string, threadId: string, archived: boolean): Promise<void> {
    this.assertProjectAccessible(projectId);
    const values = new Set(this.desktopState.archivedThreads[projectId] ?? []);
    if (archived) values.add(threadId);
    else values.delete(threadId);
    this.desktopState.archivedThreads[projectId] = [...values];
    await this.saveDesktop();
  }

  getWorkbench(projectId: string, threadId: string): WorkbenchState {
    this.assertProjectAccessible(projectId);
    return (
      this.desktopState.workbenches[workbenchKey(projectId, threadId)] ?? {
        projectId,
        threadId,
        panelOpen: false,
        panelWidth: 360,
        terminalOpen: false,
        terminalHeight: 280,
        openFiles: [],
        expandedPaths: [],
        tabs: [],
        activeTabKey: null,
      }
    );
  }

  async setWorkbench(value: WorkbenchState): Promise<void> {
    this.assertProjectAccessible(value.projectId);
    this.desktopState.workbenches[workbenchKey(value.projectId, value.threadId)] = value;
    await this.saveDesktop();
  }

  async removeWorkbench(projectId: string, threadId: string): Promise<void> {
    this.assertProjectAccessible(projectId);
    delete this.desktopState.workbenches[workbenchKey(projectId, threadId)];
    await this.saveDesktop();
  }

  private requireStored(projectId: string): StoredProject {
    const project = this.projectMetadata.projects.find(({ projectId: id }) => id === projectId);
    if (!project) throw new Error(`Project 不存在: ${projectId}`);
    return project;
  }

  private async toProject(project: StoredProject): Promise<Project> {
    try {
      const info = await stat(project.path);
      if (!info.isDirectory()) throw new Error("路径不是目录");
      project.status = "available";
      return {
        id: project.projectId,
        kind: "project",
        name: project.name,
        cwd: project.path,
        lastOpenedAt: parseTimestamp(project.lastOpenedAt),
        available: true,
      };
    } catch (error) {
      project.status = statusFromError(error);
      return {
        id: project.projectId,
        kind: "project",
        name: project.name,
        cwd: project.path,
        lastOpenedAt: parseTimestamp(project.lastOpenedAt),
        available: false,
        issue: errorMessage(error),
      };
    }
  }

  private saveProjects(): Promise<void> {
    const text = `${JSON.stringify(this.projectMetadata, null, 2)}\n`;
    const task = this.saveProjectsTask.catch(() => undefined).then(() => writeAtomic(this.projectFile, text));
    this.saveProjectsTask = task;
    return task;
  }

  private saveDesktop(): Promise<void> {
    const text = `${JSON.stringify(this.desktopState, null, 2)}\n`;
    const task = this.saveDesktopTask.catch(() => undefined).then(() => writeAtomic(this.desktopFile, text));
    this.saveDesktopTask = task;
    return task;
  }
}

async function normalizeDirectory(folder: string): Promise<string> {
  const path = await realpath(resolve(folder));
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error("选择的路径不是目录");
  return path;
}

async function readOptionalJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, text, "utf8");
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

function fromLegacyProject(project: NonNullable<LegacyDesktopState["projects"]>[number]): StoredProject {
  const now = new Date().toISOString();
  const lastOpenedAt = new Date(project.lastOpenedAt).toISOString();
  return {
    projectId: project.id,
    name: project.name,
    path: project.cwd,
    status: "available",
    createdAt: now,
    updatedAt: now,
    lastOpenedAt,
  };
}

function parseTimestamp(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function statusFromError(error: unknown): ProjectStatus {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  if (code === "ENOENT") return "missing";
  if (code === "EACCES" || code === "EPERM") return "permissionDenied";
  return "invalid";
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isProjectMetadataFile(value: unknown): value is ProjectMetadataFile {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return state.version === 1 && Array.isArray(state.projects) && state.projects.every(isStoredProject);
}

function isStoredProject(value: unknown): value is StoredProject {
  if (!value || typeof value !== "object") return false;
  const project = value as Record<string, unknown>;
  return (
    typeof project.projectId === "string" &&
    typeof project.name === "string" &&
    typeof project.path === "string" &&
    typeof project.status === "string" &&
    ["available", "missing", "permissionDenied", "invalid"].includes(project.status) &&
    typeof project.createdAt === "string" &&
    typeof project.updatedAt === "string"
  );
}

function isDesktopState(value: unknown): value is LegacyDesktopState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    state.version === 1 &&
    typeof state.archivedThreads === "object" &&
    state.archivedThreads !== null &&
    typeof state.workbenches === "object" &&
    state.workbenches !== null
  );
}

function workbenchKey(projectId: string, threadId: string): string {
  return `${projectId}:${threadId}`;
}
