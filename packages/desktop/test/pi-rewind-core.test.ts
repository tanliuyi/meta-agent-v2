import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCheckpointFileDiff,
  buildCheckpointSummary,
  createCheckpoint,
  deleteSessionCheckpoints,
  git,
  loadAllCheckpoints,
  MAX_UNTRACKED_FILE_SIZE,
  restoreCheckpoint,
  ZEROS,
} from "../src/main/pi/extensions/pi-rewind/src/core.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "desktop-pi-rewind-"));
  temporaryDirectories.push(root);
  await git(["init"], root);
  await git(["config", "user.email", "test@example.com"], root);
  await git(["config", "user.name", "Desktop Test"], root);
  await git(["config", "core.autocrlf", "false"], root);
  await writeFile(join(root, "tracked.txt"), "before\n");
  await git(["add", "tracked.txt"], root);
  await git(["commit", "-m", "initial"], root);
  return root;
}

describe("pi-rewind core", () => {
  it("captures per-file diffs and restores files without moving HEAD", async () => {
    const root = await createRepository();
    const before = await createCheckpoint({
      root,
      id: "before",
      sessionId: "session-1",
      trigger: "resume",
      turnIndex: 0,
    });
    const headBefore = await git(["rev-parse", "HEAD"], root);

    await writeFile(join(root, "tracked.txt"), "after\n");
    await writeFile(join(root, "created.txt"), "created\n");
    const after = await createCheckpoint({
      root,
      id: "after",
      sessionId: "session-1",
      trigger: "tool",
      turnIndex: 1,
    });
    const diff = await buildCheckpointSummary(root, before.worktreeTreeSha, after.worktreeTreeSha);
    const trackedPatch = await buildCheckpointFileDiff(
      root,
      before.worktreeTreeSha,
      after.worktreeTreeSha,
      "tracked.txt",
    );

    expect(diff).toMatchObject({ fileCount: 2, additions: 2, deletions: 1, truncated: false });
    expect(diff.files.map((file) => file.path)).toEqual(["created.txt", "tracked.txt"]);
    expect(trackedPatch.patch).toContain("+after");

    await restoreCheckpoint(root, before);

    expect((await readFile(join(root, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("before\n");
    await expect(readFile(join(root, "created.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(["rev-parse", "HEAD"], root)).toBe(headBefore);
    expect(await git(["status", "--short"], root)).toBe("");
  });

  it("keeps divergent staged contents reachable after Git garbage collection", async () => {
    const root = await createRepository();
    await writeFile(join(root, "tracked.txt"), "staged-only\n");
    await git(["add", "tracked.txt"], root);
    await writeFile(join(root, "tracked.txt"), "worktree-only\n");
    const checkpoint = await createCheckpoint({
      root,
      id: "gc-safe-index",
      sessionId: "session-gc",
      trigger: "tool",
      turnIndex: 1,
    });

    await writeFile(join(root, "tracked.txt"), "later\n");
    await git(["add", "tracked.txt"], root);
    await git(["reflog", "expire", "--expire=now", "--all"], root);
    await git(["gc", "--prune=now"], root);
    await restoreCheckpoint(root, checkpoint);

    expect((await readFile(join(root, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("worktree-only\n");
    expect(await git(["show", ":tracked.txt"], root)).toBe("staged-only");
  });

  it("refuses to overwrite an untracked file excluded by the size limit", async () => {
    const root = await createRepository();
    const path = join(root, "artifact.bin");
    await writeFile(path, "small\n");
    const checkpoint = await createCheckpoint({
      root,
      id: "small-artifact",
      sessionId: "session-large",
      trigger: "tool",
      turnIndex: 1,
    });
    await writeFile(path, Buffer.alloc(MAX_UNTRACKED_FILE_SIZE + 1, 0x61));

    await expect(restoreCheckpoint(root, checkpoint)).rejects.toThrow("excluded from the current checkpoint");
    expect((await stat(path)).size).toBe(MAX_UNTRACKED_FILE_SIZE + 1);
  });

  it("refuses to overwrite an ignored unmanaged path", async () => {
    const root = await createRepository();
    const before = await createCheckpoint({
      root,
      id: "ignored-before",
      sessionId: "session-ignored",
      trigger: "resume",
      turnIndex: 1,
    });
    const ignoredPath = join(root, "node_modules", "generated.txt");
    await mkdir(dirname(ignoredPath), { recursive: true });
    await writeFile(ignoredPath, "checkpoint\n");
    await git(["add", "-f", "node_modules/generated.txt"], root);
    const target = await createCheckpoint({
      root,
      id: "ignored-target",
      sessionId: "session-ignored",
      trigger: "tool",
      turnIndex: 2,
    });
    await restoreCheckpoint(root, before);
    await mkdir(dirname(ignoredPath), { recursive: true });
    await writeFile(ignoredPath, "current unmanaged\n");

    await expect(restoreCheckpoint(root, target)).rejects.toThrow("unmanaged or ignored path");
    expect(await readFile(ignoredPath, "utf8")).toBe("current unmanaged\n");
  });

  it("refuses to overwrite a directory excluded by the file-count limit", async () => {
    const root = await createRepository();
    const before = await createCheckpoint({
      root,
      id: "large-dir-before",
      sessionId: "session-large-dir",
      trigger: "resume",
      turnIndex: 1,
    });
    const directory = join(root, "bulk");
    await mkdir(directory, { recursive: true });
    await Promise.all(
      Array.from({ length: 201 }, (_, index) => writeFile(join(directory, `${index}.txt`), `target ${index}\n`)),
    );
    await git(["add", "bulk"], root);
    const target = await createCheckpoint({
      root,
      id: "large-dir-target",
      sessionId: "session-large-dir",
      trigger: "tool",
      turnIndex: 2,
    });
    await restoreCheckpoint(root, before);
    await mkdir(directory, { recursive: true });
    await Promise.all(
      Array.from({ length: 201 }, (_, index) => writeFile(join(directory, `${index}.txt`), `current ${index}\n`)),
    );

    await expect(restoreCheckpoint(root, target)).rejects.toThrow("excluded from the current checkpoint");
    expect(await readFile(join(directory, "0.txt"), "utf8")).toBe("current 0\n");
  });

  it("rolls back target files that become excluded after a partial restore", async () => {
    const root = await createRepository();
    const before = await createCheckpoint({
      root,
      id: "rollback-before",
      sessionId: "session-rollback",
      trigger: "resume",
      turnIndex: 1,
    });
    const artifactPath = join(root, "artifact.bin");
    await writeFile(artifactPath, Buffer.alloc(MAX_UNTRACKED_FILE_SIZE + 1, 0x62));
    await git(["add", "artifact.bin"], root);
    const target = await createCheckpoint({
      root,
      id: "rollback-target",
      sessionId: "session-rollback",
      trigger: "tool",
      turnIndex: 2,
    });
    await restoreCheckpoint(root, before);

    await expect(restoreCheckpoint(root, { ...target, indexTreeSha: ZEROS }, before)).rejects.toThrow();
    await expect(stat(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readFile(join(root, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("before\n");
    expect(await git(["status", "--porcelain"], root)).toBe("");
  });

  it("deletes checkpoint refs only for removed sessions", async () => {
    const root = await createRepository();
    await createCheckpoint({
      root,
      id: "resume-session-remove-1",
      sessionId: "session-remove",
      trigger: "resume",
      turnIndex: 0,
    });
    await createCheckpoint({
      root,
      id: "resume-session-keep-1",
      sessionId: "session-keep",
      trigger: "resume",
      turnIndex: 0,
    });

    await deleteSessionCheckpoints(root, ["session-remove"]);

    expect((await loadAllCheckpoints(root)).map((checkpoint) => checkpoint.sessionId)).toEqual(["session-keep"]);
  });

  it("handles checkpoint paths containing spaces without shell parsing", async () => {
    const root = await createRepository();
    await writeFile(join(root, "path with spaces.txt"), "first\n");
    const checkpoint = await createCheckpoint({
      root,
      id: "spaces",
      sessionId: "session-2",
      trigger: "tool",
      turnIndex: 1,
    });

    await writeFile(join(root, "path with spaces.txt"), "second\n");
    await restoreCheckpoint(root, checkpoint);

    expect((await readFile(join(root, "path with spaces.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("first\n");
  });

  it("rejects restore across branches", async () => {
    const root = await createRepository();
    const checkpoint = await createCheckpoint({
      root,
      id: "main-state",
      sessionId: "session-3",
      trigger: "resume",
      turnIndex: 0,
    });
    await git(["switch", "-c", "feature"], root);

    await expect(restoreCheckpoint(root, checkpoint)).rejects.toThrow(/belongs to branch/i);
  });
});
