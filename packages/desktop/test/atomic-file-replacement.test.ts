import type { PathLike } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@earendil-works/pi-office-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceFileAtomically } from "../src/main/files/atomic-file-replacement.ts";

type Rename = (oldPath: PathLike, newPath: PathLike) => Promise<void>;

const fsMocks = vi.hoisted(() => ({
  actualRename: undefined as Rename | undefined,
  actualUnlink: undefined as typeof unlink | undefined,
  actualWriteFile: undefined as typeof writeFile | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  fsMocks.actualRename = actual.rename;
  fsMocks.actualUnlink = actual.unlink;
  fsMocks.actualWriteFile = actual.writeFile;
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink),
    writeFile: vi.fn(actual.writeFile),
  };
});

const roots: string[] = [];

beforeEach(() => {
  if (!fsMocks.actualRename || !fsMocks.actualUnlink || !fsMocks.actualWriteFile) {
    throw new Error("filesystem mocks were not initialized");
  }
  vi.mocked(rename).mockReset().mockImplementation(fsMocks.actualRename);
  vi.mocked(unlink).mockReset().mockImplementation(fsMocks.actualUnlink);
  vi.mocked(writeFile).mockReset().mockImplementation(fsMocks.actualWriteFile);
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Office document file replacement", () => {
  it("通过同目录临时文件替换完整内容并清理临时文件", async () => {
    const fixture = await createFixture();

    await replaceFileAtomically(fixture.path, sha256Hex(fixture.before), fixture.after);

    await expectFile(fixture.path, fixture.after);
    expect(await transactionFiles(fixture.root)).toEqual([]);
  });

  it("源文件 stale 时保持外部内容", async () => {
    const fixture = await createFixture();
    const external = new TextEncoder().encode("external update");
    await writeFile(fixture.path, external);

    await expect(replaceFileAtomically(fixture.path, sha256Hex(fixture.before), fixture.after)).rejects.toThrow(
      "STALE_DOCUMENT",
    );

    await expectFile(fixture.path, external);
    expect(await transactionFiles(fixture.root)).toEqual([]);
  });

  it("重试瞬时 rename 锁并完成替换", async () => {
    const fixture = await createFixture();
    vi.mocked(rename)
      .mockRejectedValueOnce(renameError("EPERM"))
      .mockRejectedValueOnce(renameError("EBUSY"))
      .mockImplementationOnce(fsMocks.actualRename!);

    await replaceFileAtomically(fixture.path, sha256Hex(fixture.before), fixture.after);

    await expectFile(fixture.path, fixture.after);
    expect(rename).toHaveBeenCalledTimes(3);
  });

  it("rename 持续被锁时退化为原地写入", async () => {
    const fixture = await createFixture();
    vi.mocked(rename).mockRejectedValue(renameError("EACCES"));

    await replaceFileAtomically(fixture.path, sha256Hex(fixture.before), fixture.after);

    await expectFile(fixture.path, fixture.after);
    expect(rename).toHaveBeenCalledTimes(5);
    expect(await transactionFiles(fixture.root)).toEqual([]);
  });

  it("临时文件写入失败时清理部分结果", async () => {
    const fixture = await createFixture();
    vi.mocked(writeFile).mockImplementationOnce(async (path) => {
      await fsMocks.actualWriteFile!(path, fixture.after.subarray(0, 3));
      throw new Error("write failed");
    });

    await expect(replaceFileAtomically(fixture.path, sha256Hex(fixture.before), fixture.after)).rejects.toThrow(
      "write failed",
    );

    await expectFile(fixture.path, fixture.before);
    expect(await transactionFiles(fixture.root)).toEqual([]);
  });

  it("原地覆盖成功后忽略临时文件清理错误", async () => {
    const fixture = await createFixture();
    vi.mocked(rename).mockRejectedValue(renameError("EACCES"));
    vi.mocked(unlink).mockRejectedValueOnce(new Error("unlink failed"));

    await replaceFileAtomically(fixture.path, sha256Hex(fixture.before), fixture.after);

    await expectFile(fixture.path, fixture.after);
  });

  it("重试期间源文件变化时拒绝覆盖并清理临时文件", async () => {
    const fixture = await createFixture();
    const external = new TextEncoder().encode("external update during retry");
    vi.mocked(rename).mockImplementationOnce(async () => {
      await writeFile(fixture.path, external);
      throw renameError("EBUSY");
    });

    await expect(replaceFileAtomically(fixture.path, sha256Hex(fixture.before), fixture.after)).rejects.toThrow(
      "STALE_DOCUMENT",
    );

    await expectFile(fixture.path, external);
    expect(await transactionFiles(fixture.root)).toEqual([]);
  });

  it("非瞬时 rename 错误保持源文件并清理临时文件", async () => {
    const fixture = await createFixture();
    vi.mocked(rename).mockRejectedValue(renameError("EXDEV"));

    await expect(replaceFileAtomically(fixture.path, sha256Hex(fixture.before), fixture.after)).rejects.toThrow(
      "rename failed",
    );

    await expectFile(fixture.path, fixture.before);
    expect(await transactionFiles(fixture.root)).toEqual([]);
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "meta-agent-office-atomic-"));
  roots.push(root);
  await mkdir(root, { recursive: true });
  const path = join(root, "document.docx");
  const before = new TextEncoder().encode("complete old document");
  const after = new TextEncoder().encode("complete new document");
  await writeFile(path, before);
  return { root, path, before, after };
}

function renameError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error("rename failed"), { code });
}

async function expectFile(path: string, expected: Uint8Array): Promise<void> {
  expect(sha256Hex(await readFile(path))).toBe(sha256Hex(expected));
}

async function transactionFiles(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) => name.endsWith(".tmp"));
}
