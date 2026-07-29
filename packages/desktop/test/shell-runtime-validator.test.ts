import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { validateBashRuntime } from "../src/main/sidecar/shell-runtime-validator.ts";

describe("shell runtime validator", () => {
  it("accepts an executable that reports a GNU Bash version", async () => {
    const path = resolve("test-fixtures", "bash.exe");
    const execute = vi.fn().mockResolvedValue({
      stdout: "GNU bash, version 5.2.37(1)-release (x86_64-pc-msys)\n",
    });

    await expect(validateBashRuntime(path, { execute })).resolves.toEqual({ path, version: "5.2.37" });
    expect(execute).toHaveBeenNthCalledWith(1, path, ["--version"]);
    expect(execute).toHaveBeenNthCalledWith(2, path, ["--noprofile", "--norc", "-c", "command -v git >/dev/null"]);
  });

  it("rejects a file that is not GNU Bash", async () => {
    const path = resolve("test-fixtures", "not-bash.exe");

    await expect(
      validateBashRuntime(path, { execute: async () => ({ stdout: "unrelated executable\n" }) }),
    ).rejects.toThrow("所选文件不是可用的 GNU Bash 可执行程序");
  });

  it("rejects GNU Bash when Git is unavailable", async () => {
    const path = resolve("test-fixtures", "bash-without-git.exe");
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "GNU bash, version 5.2.37(1)-release (x86_64-pc-msys)\n" })
      .mockRejectedValueOnce(new Error("git: command not found"));

    await expect(validateBashRuntime(path, { execute })).rejects.toThrow(
      "所选 Bash 中未找到可用的 Git: git: command not found",
    );
  });

  it("reports executable startup failures", async () => {
    const path = resolve("test-fixtures", "missing-bash.exe");

    await expect(
      validateBashRuntime(path, {
        execute: async () => {
          throw new Error("spawn ENOENT");
        },
      }),
    ).rejects.toThrow("无法运行所选 Bash: spawn ENOENT");
  });

  it("rejects relative paths before execution", async () => {
    const execute = vi.fn();

    await expect(validateBashRuntime("bash.exe", { execute })).rejects.toThrow("Bash 路径必须是绝对路径");
    expect(execute).not.toHaveBeenCalled();
  });
});
