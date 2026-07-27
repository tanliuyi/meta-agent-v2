import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ShellRuntimeProgress, ShellRuntimeStatus } from "../../shared/desktop-api.ts";
import { downloadRuntimeArchive } from "./runtime-download.ts";
import { activateRuntime, withRuntimeLock } from "./runtime-lock.ts";

export const SHELL_RUNTIME_VERSION = "2.53.0.3";
const RELEASE = "v2.53.0.windows.3";
const ARTIFACTS: Record<string, { filename: string; sha256: string }> = {
  "win32-arm64": {
    filename: "PortableGit-2.53.0.3-arm64.7z.exe",
    sha256: "0db54010054c01f35501cf69e1e32d3710138ecb934d188bd77093afed24300e",
  },
  "win32-x64": {
    filename: "PortableGit-2.53.0.3-64-bit.7z.exe",
    sha256: "b365da794b1d2225eb24d5f5e09ef7792cfd5fa26c3a3586210280c80dff3a2a",
  },
};

export class ShellRuntimeInstaller {
  private readonly userDataDir: string;
  private readonly emit: (progress: ShellRuntimeProgress) => void;
  private readonly validate: (path: string) => boolean;
  private installation?: Promise<ShellRuntimeStatus>;
  private readonly listeners = new Set<(progress: ShellRuntimeProgress) => void>();

  constructor(
    userDataDir: string,
    emit: (progress: ShellRuntimeProgress) => void,
    options: { validate?: (path: string) => boolean } = {},
  ) {
    this.userDataDir = userDataDir;
    this.validate = options.validate ?? validateBash;
    this.emit = (progress) => {
      emit(progress);
      for (const listener of this.listeners) listener(progress);
    };
  }

  onProgress(listener: (progress: ShellRuntimeProgress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  activeBashPath(): string | undefined {
    const runtimeRoot = join(this.userDataDir, "shell-runtime");
    const activePath = join(runtimeRoot, "active.json");
    if (!existsSync(activePath)) return undefined;
    try {
      const active = JSON.parse(readFileSync(activePath, "utf8")) as { root?: string };
      const executable = join(active.root ?? "", "bin", "bash.exe");
      return existsSync(executable) && this.validate(executable) ? executable : undefined;
    } catch {
      return undefined;
    }
  }

  async install(): Promise<ShellRuntimeStatus> {
    if (this.installation) return this.installation;
    this.installation = this.installOnce().finally(() => {
      this.installation = undefined;
    });
    return this.installation;
  }

  private async installOnce(): Promise<ShellRuntimeStatus> {
    const runtimeRoot = join(this.userDataDir, "shell-runtime");
    return withRuntimeLock(runtimeRoot, () => this.installLocked(runtimeRoot));
  }

  private async installLocked(runtimeRoot: string): Promise<ShellRuntimeStatus> {
    const activePath = this.activeBashPath();
    if (activePath) {
      try {
        await run(activePath, ["--noprofile", "--norc", "-c", "command -v git >/dev/null"]);
        return {
          state: "ready",
          path: activePath,
          version: SHELL_RUNTIME_VERSION,
          message: `PortableGit ${SHELL_RUNTIME_VERSION} 已安装`,
          installUrl: shellRuntimeInstallUrl(),
        };
      } catch {
        // Replace an incomplete active runtime from the verified archive below.
      }
    }
    const key = `${process.platform}-${process.arch}`;
    const artifact = ARTIFACTS[key];
    if (!artifact) throw new Error(`Unsupported shell runtime target: ${key}`);
    const cacheRoot = join(runtimeRoot, "cache");
    const cachePath = join(cacheRoot, artifact.filename);
    const stagingRoot = join(runtimeRoot, `.staging-${process.pid}-${Date.now()}`);
    const finalRoot = join(runtimeRoot, `portable-git-${SHELL_RUNTIME_VERSION}-${key}`);
    const url = shellRuntimeInstallUrl();
    this.emit({ phase: "checking", percent: 0, message: "准备 Git Bash 安装目录" });
    await mkdir(cacheRoot, { recursive: true });
    try {
      if (!existsSync(cachePath) || (await sha256(cachePath)) !== artifact.sha256) {
        this.emit({ phase: "downloading", percent: 0, message: `下载 PortableGit ${SHELL_RUNTIME_VERSION}` });
        await downloadRuntimeArchive(url, cachePath, "PortableGit", (percent) =>
          this.emit({
            phase: "downloading",
            percent,
            message: `下载 PortableGit ${SHELL_RUNTIME_VERSION} (${percent}%)`,
          }),
        );
      }
      this.emit({ phase: "verifying", percent: 55, message: "校验 PortableGit 官方归档" });
      if ((await sha256(cachePath)) !== artifact.sha256) throw new Error("PortableGit 下载校验失败");
      rmSync(stagingRoot, { recursive: true, force: true });
      mkdirSync(stagingRoot, { recursive: true });
      this.emit({ phase: "extracting", percent: 65, message: "解压 Git Bash 到用户目录" });
      await run(cachePath, ["-y", `-o${stagingRoot}`]);
      const executable = join(stagingRoot, "bin", "bash.exe");
      if (!existsSync(executable)) throw new Error("解压后的 Git Bash 可执行文件不存在");
      await run(executable, ["--noprofile", "--norc", "-c", "command -v git >/dev/null"]);
      rmSync(finalRoot, { recursive: true, force: true });
      renameSync(stagingRoot, finalRoot);
      activateRuntime(runtimeRoot, finalRoot);
      const path = join(finalRoot, "bin", "bash.exe");
      this.emit({ phase: "ready", percent: 100, message: `PortableGit ${SHELL_RUNTIME_VERSION} 安装完成` });
      return {
        state: "ready",
        path,
        version: SHELL_RUNTIME_VERSION,
        message: `PortableGit ${SHELL_RUNTIME_VERSION} 已安装`,
        installUrl: url,
      };
    } catch (error) {
      rmSync(stagingRoot, { recursive: true, force: true });
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ phase: "error", percent: 0, message: "Git Bash 安装失败", error: message });
      throw error;
    }
  }
}

export function shellRuntimeInstallUrl(): string {
  const artifact = ARTIFACTS[`${process.platform}-${process.arch}`];
  return artifact
    ? `https://github.com/git-for-windows/git/releases/download/${RELEASE}/${artifact.filename}`
    : "https://gitforwindows.org/";
}

function validateBash(path: string): boolean {
  try {
    execFileSync(path, ["--noprofile", "--norc", "-c", "command -v git >/dev/null"], {
      stdio: "ignore",
      timeout: 10_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    let timedOut = false;
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 5 * 60_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (timedOut) rejectRun(new Error(`${command} timed out after 5 minutes`));
      else if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} exited with ${code}`));
    });
  });
}

function sha256(path: string): Promise<string> {
  return readFile(path).then((data) => createHash("sha256").update(data).digest("hex"));
}
