import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitService, GitStatusParser, parseBranchLine } from "../src/main/git/git-service.ts";
import { ProjectStore } from "../src/main/store/project-store.ts";

const execFileAsync = promisify(execFile);

const roots: string[] = [];
const services: GitService[] = [];

afterEach(async () => {
  for (const svc of services.splice(0)) svc.dispose();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function createRepo(
  broadcast: (projectId: string) => void = () => undefined,
): Promise<{ projectId: string; cwd: string; service: GitService }> {
  const root = await mkdtemp(join(tmpdir(), "meta-agent-git-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  await git(cwd, ["init", "-b", "main"]);
  await git(cwd, ["config", "user.email", "test@example.com"]);
  await git(cwd, ["config", "user.name", "Test"]);
  const store = new ProjectStore(join(root, "state.json"));
  await store.load();
  const project = await store.add(cwd);
  const svc = new GitService(store, broadcast);
  services.push(svc);
  return { projectId: project.id, cwd, service: svc };
}

async function commitAll(cwd: string, message: string): Promise<void> {
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-m", message]);
}

describe("parseBranchLine", () => {
  it("解析普通分支、upstream 与 ahead/behind", () => {
    expect(parseBranchLine("## main")).toEqual({ branch: "main", ahead: 0, behind: 0 });
    expect(parseBranchLine("## main...origin/main")).toEqual({ branch: "main", ahead: 0, behind: 0 });
    expect(parseBranchLine("## main...origin/main [ahead 1]")).toEqual({ branch: "main", ahead: 1, behind: 0 });
    expect(parseBranchLine("## feat/x...origin/feat/x [ahead 3, behind 2]")).toEqual({
      branch: "feat/x",
      ahead: 3,
      behind: 2,
    });
    expect(parseBranchLine("## No commits yet on main")).toEqual({ branch: "main", ahead: 0, behind: 0 });
  });
});

describe("GitStatusParser", () => {
  it("解析 -z 输出的普通条目与重命名条目", () => {
    const parser = new GitStatusParser();
    // porcelain v1 条目为 `XY <path>`（X/Y 为状态字母，无状态时为空格）；
    // -z 模式下重命名条目为 `R  <新路径>\0<原路径>\0`（新路径在前）。
    const entries = parser.parse("## main\0 M file1.ts\0?? new.txt\0R  renamed.ts\0old.ts\0");
    expect(entries).toEqual([
      { index: " ", worktree: "M", path: "file1.ts" },
      { index: "?", worktree: "?", path: "new.txt" },
      { index: "R", worktree: " ", path: "renamed.ts", originalPath: "old.ts" },
    ]);
  });

  it("跳过 ignored 与嵌套仓库条目", () => {
    const parser = new GitStatusParser();
    const entries = parser.parse("## main\n!! ignored.log\0?? sub/\0");
    expect(entries).toEqual([]);
  });
});

describe("GitService", () => {
  it("非仓库目录返回 not-a-repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "meta-agent-git-"));
    roots.push(root);
    const cwd = join(root, "plain");
    await mkdir(cwd);
    const store = new ProjectStore(join(root, "state.json"));
    await store.load();
    const project = await store.add(cwd);
    const svc = new GitService(store, () => undefined);
    services.push(svc);
    const result = await svc.getStatus(project.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-a-repo");
  });

  it("父仓库子目录只展示并暂存 Project 范围内的变更", async () => {
    const root = await mkdtemp(join(tmpdir(), "meta-agent-git-"));
    roots.push(root);
    const repository = join(root, "repository");
    const cwd = join(repository, "project");
    await mkdir(repository);
    await mkdir(cwd);
    await git(repository, ["init", "-b", "main"]);
    await git(repository, ["config", "user.email", "test@example.com"]);
    await git(repository, ["config", "user.name", "Test"]);
    await writeFile(join(cwd, "inside.txt"), "inside-v1\n");
    await writeFile(join(repository, "outside.txt"), "outside-v1\n");
    await commitAll(repository, "init");
    await writeFile(join(cwd, "inside.txt"), "inside-v2\n");
    await writeFile(join(repository, "outside.txt"), "outside-v2\n");

    const store = new ProjectStore(join(root, "state.json"));
    await store.load();
    const project = await store.add(cwd);
    const service = new GitService(store, () => undefined);
    services.push(service);

    const status = await service.getStatus(project.id);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.state.root).toBe(await realpath(cwd));
    expect(status.state.groups.find((group) => group.kind === "unstaged")?.changes).toEqual([
      expect.objectContaining({ path: "inside.txt" }),
    ]);

    await service.stage({ projectId: project.id });
    const staged = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd: repository });
    expect(staged.stdout.trim()).toBe("project/inside.txt");
  });

  it("拒绝读取或操作 Project 外路径", async () => {
    const { projectId, cwd, service } = await createRepo();
    await writeFile(join(cwd, "tracked.txt"), "tracked\n");
    await writeFile(join(cwd, "..", "secret.txt"), "secret\n");
    await commitAll(cwd, "init");

    const diff = await service.diffUntracked({ projectId, path: "../secret.txt", staged: false });
    expect(diff).toMatchObject({ ok: false, reason: "error" });
    await expect(service.stage({ projectId, paths: ["../secret.txt"] })).rejects.toThrow("超出 Project cwd");
  });

  it("分组：未跟踪 / 更改 / 暂存的更改", async () => {
    const { projectId, cwd, service } = await createRepo();
    await writeFile(join(cwd, "tracked.txt"), "v1");
    await commitAll(cwd, "init");
    await writeFile(join(cwd, "tracked.txt"), "v2");
    await writeFile(join(cwd, "untracked.txt"), "new");

    const result = await service.getStatus(projectId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.branch).toBe("main");
    expect(result.state.groups.map((group) => [group.kind, group.changes.length])).toEqual([
      ["merge", 0],
      ["staged", 0],
      ["unstaged", 1],
      ["untracked", 1],
    ]);
    const unstaged = result.state.groups.find((group) => group.kind === "unstaged");
    expect(unstaged?.changes[0]).toMatchObject({ path: "tracked.txt", worktreeKind: "modified" });

    await service.stage({ projectId, paths: ["tracked.txt", "untracked.txt"] });
    const staged = await service.getStatus(projectId);
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    const groups = Object.fromEntries(staged.state.groups.map((group) => [group.kind, group.changes]));
    expect(groups.staged?.map((change) => change.path).sort()).toEqual(["tracked.txt", "untracked.txt"]);
    expect(groups.unstaged).toHaveLength(0);
    expect(groups.untracked).toHaveLength(0);
  });

  it("重命名与删除进入对应分组，且保留 originalPath", async () => {
    const { projectId, cwd, service } = await createRepo();
    await writeFile(join(cwd, "old.ts"), "x");
    await writeFile(join(cwd, "gone.txt"), "y");
    await commitAll(cwd, "init");
    await git(cwd, ["mv", "old.ts", "new.ts"]);
    await git(cwd, ["rm", "-q", "gone.txt"]);

    const result = await service.getStatus(projectId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const groups = Object.fromEntries(result.state.groups.map((group) => [group.kind, group.changes]));
    expect(groups.staged).toContainEqual(expect.objectContaining({ path: "new.ts", originalPath: "old.ts" }));
    expect(groups.staged).toContainEqual(expect.objectContaining({ path: "gone.txt", indexKind: "deleted" }));
  });

  it("提交后状态清空，HEAD 短哈希可用", async () => {
    const { projectId, cwd, service } = await createRepo();
    await writeFile(join(cwd, "a.txt"), "1");
    await commitAll(cwd, "init");
    await writeFile(join(cwd, "a.txt"), "2");
    await service.stage({ projectId });
    const commitResult = await service.commit({ projectId, message: "second" });
    expect(commitResult).toEqual({ ok: true });

    const result = await service.getStatus(projectId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.totalChanges).toBe(0);
    expect(result.state.head).toMatch(/^[0-9a-f]{7,}$/);
  });

  it("空提交信息返回 ok:false", async () => {
    const { projectId, service } = await createRepo();
    const result = await service.commit({ projectId, message: "   " });
    expect(result).toEqual({ ok: false, message: "提交信息不能为空" });
  });

  it("discard 恢复已跟踪文件并删除未跟踪文件", async () => {
    const { projectId, cwd, service } = await createRepo();
    await writeFile(join(cwd, "tracked.txt"), "v1");
    await commitAll(cwd, "init");
    await writeFile(join(cwd, "tracked.txt"), "v2");
    await writeFile(join(cwd, "junk.txt"), "junk");

    await service.discard({ projectId });
    const result = await service.getStatus(projectId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.totalChanges).toBe(0);
  });

  it("watch 在 .git/index 变化时广播（合并去抖）", async () => {
    const events: string[] = [];
    const { projectId, cwd, service } = await createRepo((id) => events.push(id));
    await writeFile(join(cwd, "a.txt"), "1");
    await commitAll(cwd, "init");
    await writeFile(join(cwd, "a.txt"), "changed");
    service.watch(projectId);
    await new Promise((resolve) => setTimeout(resolve, 200));

    await git(cwd, ["add", "a.txt"]);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(events).toContain(projectId);
  });

  it("diff：未暂存修改返回工作区与 index 的 unified diff", async () => {
    const { projectId, cwd, service } = await createRepo();
    await writeFile(join(cwd, "a.txt"), "line1\nline2\n");
    await commitAll(cwd, "init");
    await writeFile(join(cwd, "a.txt"), "line1\nchanged\n");

    const result = await service.diff({ projectId, path: "a.txt", staged: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch).toContain("-line2");
    expect(result.patch).toContain("+changed");
    expect(result.patch).toMatch(/@@/);
  });

  it("diff：完整展示文件首尾行，并保留独立 hunk 边界", async () => {
    const { projectId, cwd, service } = await createRepo();
    const original = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`);
    await writeFile(join(cwd, "full.txt"), `${original.join("\n")}\n`);
    await commitAll(cwd, "init");
    const modified = [...original];
    modified[4] = "changed-five";
    modified[14] = "changed-fifteen";
    await writeFile(join(cwd, "full.txt"), `${modified.join("\n")}\n`);

    const result = await service.diff({ projectId, path: "full.txt", staged: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch).toContain(" line-1");
    expect(result.patch).toContain(" line-20");
    expect(result.hunks).toHaveLength(2);
    expect(result.hunks.map((hunk) => hunk.newStart)).toEqual([5, 15]);
  });

  it("hunk 操作：暂存、撤销暂存和还原只影响目标块", async () => {
    const { projectId, cwd, service } = await createRepo();
    const original = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`);
    await writeFile(join(cwd, "chunks.txt"), `${original.join("\n")}\n`);
    await commitAll(cwd, "init");
    const modified = [...original];
    modified[3] = "changed-four";
    modified[15] = "changed-sixteen";
    await writeFile(join(cwd, "chunks.txt"), `${modified.join("\n")}\n`);

    const unstagedDiff = await service.diff({ projectId, path: "chunks.txt", staged: false });
    expect(unstagedDiff.ok).toBe(true);
    if (!unstagedDiff.ok) return;
    expect(unstagedDiff.hunks).toHaveLength(2);
    expect(
      await service.applyHunk({
        projectId,
        path: "chunks.txt",
        hunkId: unstagedDiff.hunks[0]?.id ?? "",
        action: "stage",
      }),
    ).toEqual({ ok: true });

    const partlyStaged = await service.getStatus(projectId);
    expect(partlyStaged.ok).toBe(true);
    if (!partlyStaged.ok) return;
    expect(partlyStaged.state.groups.find((group) => group.kind === "staged")?.changes).toHaveLength(1);
    expect(partlyStaged.state.groups.find((group) => group.kind === "unstaged")?.changes).toHaveLength(1);
    expect(await readFile(join(cwd, "chunks.txt"), "utf8")).toContain("changed-sixteen");

    const stagedDiff = await service.diff({ projectId, path: "chunks.txt", staged: true });
    expect(stagedDiff.ok).toBe(true);
    if (!stagedDiff.ok) return;
    expect(
      await service.applyHunk({
        projectId,
        path: "chunks.txt",
        hunkId: stagedDiff.hunks[0]?.id ?? "",
        action: "unstage",
      }),
    ).toEqual({ ok: true });

    const refreshedDiff = await service.diff({ projectId, path: "chunks.txt", staged: false });
    expect(refreshedDiff.ok).toBe(true);
    if (!refreshedDiff.ok) return;
    expect(
      await service.applyHunk({
        projectId,
        path: "chunks.txt",
        hunkId: refreshedDiff.hunks[0]?.id ?? "",
        action: "discard",
      }),
    ).toEqual({ ok: true });
    const reverted = await readFile(join(cwd, "chunks.txt"), "utf8");
    expect(reverted).toContain("line-4");
    expect(reverted).toContain("changed-sixteen");
  });

  it("hunk 操作拒绝过期块", async () => {
    const { projectId, cwd, service } = await createRepo();
    await writeFile(join(cwd, "stale.txt"), "before\n");
    await commitAll(cwd, "init");
    await writeFile(join(cwd, "stale.txt"), "first\n");
    const diff = await service.diff({ projectId, path: "stale.txt", staged: false });
    expect(diff.ok).toBe(true);
    if (!diff.ok) return;
    await writeFile(join(cwd, "stale.txt"), "second\n");

    const result = await service.applyHunk({
      projectId,
      path: "stale.txt",
      hunkId: diff.hunks[0]?.id ?? "",
      action: "stage",
    });
    expect(result).toMatchObject({ ok: false, reason: "stale" });
  });

  it("diff：staged 对比 index 与 HEAD", async () => {
    const { projectId, cwd, service } = await createRepo();
    await writeFile(join(cwd, "a.txt"), "v1\n");
    await commitAll(cwd, "init");
    await writeFile(join(cwd, "a.txt"), "v2\n");
    await service.stage({ projectId, paths: ["a.txt"] });

    const result = await service.diff({ projectId, path: "a.txt", staged: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch).toContain("-v1");
    expect(result.patch).toContain("+v2");
  });

  it("diff：无变更文件返回 no-diff", async () => {
    const { projectId, cwd, service } = await createRepo();
    await writeFile(join(cwd, "a.txt"), "v1\n");
    await commitAll(cwd, "init");

    const result = await service.diff({ projectId, path: "a.txt", staged: false });
    expect(result).toMatchObject({ ok: false, reason: "no-diff" });
  });

  it("diffUntracked：未跟踪文件整体作为新增展示", async () => {
    const { projectId, cwd, service } = await createRepo();
    await writeFile(join(cwd, "a.txt"), "v1\n");
    await commitAll(cwd, "init");
    await writeFile(join(cwd, "new.txt"), "hello\nworld\n");

    const result = await service.diffUntracked({ projectId, path: "new.txt", staged: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch).toContain("+hello");
    expect(result.patch).toContain("+world");
    expect(result.hunks).toHaveLength(1);
    expect(
      await service.applyHunk({
        projectId,
        path: "new.txt",
        hunkId: result.hunks[0]?.id ?? "",
        action: "stage",
        untracked: true,
      }),
    ).toEqual({ ok: true });
    const status = await service.getStatus(projectId);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.state.groups.find((group) => group.kind === "staged")?.changes).toContainEqual(
      expect.objectContaining({ path: "new.txt" }),
    );
    expect(status.state.groups.find((group) => group.kind === "untracked")?.changes).toHaveLength(0);
  });
});
