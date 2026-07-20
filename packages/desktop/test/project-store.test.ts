import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../src/main/store/project-store.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ProjectStore", () => {
  it("按 project 和 session 独立恢复 Workbench 状态", async () => {
    const { file, project, store } = await createStore();
    const first = store.getWorkbench(project.id, "first");
    const second = store.getWorkbench(project.id, "second");

    await Promise.all([
      store.setWorkbench({ ...first, panel: "files", panelOpen: true, openFiles: ["README.md"] }),
      store.setWorkbench({ ...second, panel: "tasks", panelOpen: true, terminalOpen: true }),
    ]);

    const restored = new ProjectStore(file);
    await restored.load();
    expect(restored.getWorkbench(project.id, "first")).toMatchObject({
      threadId: "first",
      panel: "files",
      openFiles: ["README.md"],
      terminalOpen: false,
    });
    expect(restored.getWorkbench(project.id, "second")).toMatchObject({
      threadId: "second",
      panel: "tasks",
      openFiles: [],
      terminalOpen: true,
    });
  });

  it("并发保存后状态文件仍是完整 JSON", async () => {
    const { file, project, store } = await createStore();
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.setArchived(project.id, `thread-${index}`, true)));

    const persisted: unknown = JSON.parse(await readFile(file, "utf8"));
    expect(persisted).toEqual(
      expect.objectContaining({
        archivedThreads: {
          [project.id]: Array.from({ length: 20 }, (_, index) => `thread-${index}`),
        },
      }),
    );
  });

  it("将项目 registry 与 Desktop UI 状态分开持久化", async () => {
    const { file, project, store } = await createStore();
    await store.setArchived(project.id, "thread-1", true);

    const desktopState = JSON.parse(await readFile(file, "utf8"));
    const projectMetadata = JSON.parse(await readFile(join(rootDirectory(file), "projects.json"), "utf8"));
    expect(desktopState).not.toHaveProperty("projects");
    expect(desktopState.archivedThreads).toEqual({ [project.id]: ["thread-1"] });
    expect(projectMetadata.projects[0]).toMatchObject({ projectId: project.id, path: project.cwd });
    expect(projectMetadata.projects[0]).not.toHaveProperty("cwd");
  });

  it("迁移旧 desktop-state 中嵌套的项目记录", async () => {
    const root = await mkdtemp(join(tmpdir(), "meta-agent-project-migration-"));
    roots.push(root);
    const cwd = join(root, "workspace");
    const file = join(root, "state", "desktop-state.json");
    await mkdir(cwd);
    await mkdir(join(root, "state"));
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        activeProjectId: "legacy-project",
        projects: [{ id: "legacy-project", name: "Legacy", cwd, lastOpenedAt: 1_700_000_000_000 }],
        archivedThreads: {},
        workbenches: {},
      }),
    );

    const store = new ProjectStore(file);
    await store.load();
    expect(await store.getActive()).toMatchObject({ id: "legacy-project", cwd, available: true });
    const metadata = JSON.parse(await readFile(join(root, "state", "projects.json"), "utf8"));
    expect(metadata.projects[0]).toMatchObject({ projectId: "legacy-project", path: cwd });
    expect(JSON.parse(await readFile(file, "utf8"))).not.toHaveProperty("projects");
  });
});

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), "meta-agent-project-store-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  const file = join(root, "state", "desktop-state.json");
  await mkdir(cwd);
  const store = new ProjectStore(file);
  await store.load();
  const project = await store.add(cwd);
  return { file, project, store };
}

function rootDirectory(file: string): string {
  return dirname(file);
}
