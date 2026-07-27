import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NodeRuntimeProgress, NodeRuntimeStatus } from "../../shared/desktop-api.ts";
import { REQUIRED_NODE_VERSION } from "./node-runtime-locator.ts";
import { downloadRuntimeArchive } from "./runtime-download.ts";
import { activateRuntime, withRuntimeLock } from "./runtime-lock.ts";

const NODE_VERSION = "24.15.0";
const ARTIFACTS: Record<string, { filename: string; sha256: string }> = {
  "darwin-arm64": {
    filename: "node-v24.15.0-darwin-arm64.tar.gz",
    sha256: "372331b969779ab5d15b949884fc6eaf88d5afe87bde8ba881d6400b9100ffc4",
  },
  "darwin-x64": {
    filename: "node-v24.15.0-darwin-x64.tar.gz",
    sha256: "ffd5ee293467927f3ee731a553eb88fd1f48cf74eebc2d74a6babe4af228673b",
  },
  "linux-arm64": {
    filename: "node-v24.15.0-linux-arm64.tar.xz",
    sha256: "f3d5a797b5d210ce8e2cb265544c8e482eaedcb8aa409a8b46da7e8595d0dda0",
  },
  "linux-x64": {
    filename: "node-v24.15.0-linux-x64.tar.xz",
    sha256: "472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6",
  },
  "win32-arm64": {
    filename: "node-v24.15.0-win-arm64.zip",
    sha256: "c9eb7402eda26e2ba7e44b6727fc85a8de56c5095b1f71ebd3062892211aa116",
  },
  "win32-x64": {
    filename: "node-v24.15.0-win-x64.zip",
    sha256: "cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62",
  },
};

export class NodeRuntimeInstaller {
  private readonly userDataDir: string;
  private readonly emit: (progress: NodeRuntimeProgress) => void;
  private installation?: Promise<NodeRuntimeStatus>;
  private readonly listeners = new Set<(progress: NodeRuntimeProgress) => void>();

  constructor(userDataDir: string, emit: (progress: NodeRuntimeProgress) => void) {
    this.userDataDir = userDataDir;
    this.emit = (progress) => {
      emit(progress);
      for (const listener of this.listeners) listener(progress);
    };
  }

  onProgress(listener: (progress: NodeRuntimeProgress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  activeNodePath(): string | undefined {
    const runtimeRoot = join(this.userDataDir, "node-runtime");
    const activePath = join(runtimeRoot, "active.json");
    if (!existsSync(activePath)) return undefined;
    try {
      const active = JSON.parse(readFileSync(activePath, "utf8")) as { root?: string };
      const executable = join(active.root ?? "", process.platform === "win32" ? "node.exe" : "bin/node");
      return existsSync(executable) ? executable : undefined;
    } catch {
      return undefined;
    }
  }

  async install(): Promise<NodeRuntimeStatus> {
    if (this.installation) return this.installation;
    this.installation = this.installOnce().finally(() => {
      this.installation = undefined;
    });
    return this.installation;
  }

  private async installOnce(): Promise<NodeRuntimeStatus> {
    const runtimeRoot = join(this.userDataDir, "node-runtime");
    return withRuntimeLock(runtimeRoot, () => this.installLocked(runtimeRoot));
  }

  private async installLocked(runtimeRoot: string): Promise<NodeRuntimeStatus> {
    const activePath = this.activeNodePath();
    if (activePath) {
      try {
        await run(activePath, ["-e", `if(process.version!=="v${NODE_VERSION}")process.exit(1)`]);
        return {
          state: "ready",
          path: activePath,
          version: `v${NODE_VERSION}`,
          requiredVersion: REQUIRED_NODE_VERSION,
          message: `Node.js ${NODE_VERSION} 已安装`,
          installUrl: nodeRuntimeUrl(),
        };
      } catch {
        // Replace an incomplete active runtime from the verified archive below.
      }
    }
    const key = `${process.platform}-${process.arch}`;
    const artifact = ARTIFACTS[key];
    if (!artifact) throw new Error(`Unsupported Node runtime target: ${key}`);
    const cacheRoot = join(runtimeRoot, "cache");
    const cachePath = join(cacheRoot, artifact.filename);
    const stagingRoot = join(runtimeRoot, `.staging-${process.pid}-${Date.now()}`);
    const finalRoot = join(runtimeRoot, `node-v${NODE_VERSION}-${key}`);
    const url = nodeRuntimeUrl();
    this.emit({ phase: "checking", percent: 0, message: "准备 Node.js 安装目录" });
    await mkdir(cacheRoot, { recursive: true });
    try {
      if (!existsSync(cachePath) || (await sha256(cachePath)) !== artifact.sha256) {
        this.emit({ phase: "downloading", percent: 0, message: `下载 Node.js ${NODE_VERSION}` });
        await downloadRuntimeArchive(url, cachePath, "Node.js", (percent) =>
          this.emit({ phase: "downloading", percent, message: `下载 Node.js ${NODE_VERSION} (${percent}%)` }),
        );
      }
      this.emit({ phase: "verifying", percent: 55, message: "校验 Node.js 官方归档" });
      if ((await sha256(cachePath)) !== artifact.sha256) throw new Error("Node.js 下载校验失败");
      rmSync(stagingRoot, { recursive: true, force: true });
      mkdirSync(stagingRoot, { recursive: true });
      this.emit({ phase: "extracting", percent: 65, message: "解压 Node.js 到用户目录" });
      await extractArchive(cachePath, stagingRoot, artifact.filename);
      normalizeExtractedRuntime(stagingRoot);
      const executable = join(stagingRoot, process.platform === "win32" ? "node.exe" : "bin/node");
      if (!existsSync(executable)) throw new Error("解压后的 Node.js 可执行文件不存在");
      if (process.platform !== "win32") await chmod(executable, 0o755);
      rmSync(finalRoot, { recursive: true, force: true });
      renameSync(stagingRoot, finalRoot);
      activateRuntime(runtimeRoot, finalRoot);
      this.emit({ phase: "ready", percent: 100, message: `Node.js ${NODE_VERSION} 安装完成` });
      return {
        state: "ready",
        path: join(finalRoot, process.platform === "win32" ? "node.exe" : "bin/node"),
        version: `v${NODE_VERSION}`,
        requiredVersion: REQUIRED_NODE_VERSION,
        message: `Node.js ${NODE_VERSION} 已安装`,
        installUrl: url,
      };
    } catch (error) {
      rmSync(stagingRoot, { recursive: true, force: true });
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ phase: "error", percent: 0, message: "Node.js 安装失败", error: message });
      throw error;
    }
  }
}

function nodeRuntimeUrl(): string {
  const artifact = ARTIFACTS[`${process.platform}-${process.arch}`];
  return artifact ? `https://nodejs.org/dist/v${NODE_VERSION}/${artifact.filename}` : "https://nodejs.org/";
}

async function extractArchive(archivePath: string, destination: string, filename: string): Promise<void> {
  if (filename.endsWith(".zip")) {
    await run("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${destination.replaceAll("'", "''")}' -Force`,
    ]);
    return;
  }
  await run("tar", ["-xf", archivePath, "--strip-components=1", "-C", destination]);
}

function normalizeExtractedRuntime(root: string): void {
  const expected = process.platform === "win32" ? "node.exe" : "bin/node";
  if (existsSync(join(root, expected))) return;
  const entries = requireDirectoryEntries(root);
  if (entries.length !== 1 || !existsSync(join(root, entries[0]!, expected))) {
    throw new Error(`Node.js archive does not contain ${expected}`);
  }
  const extracted = join(root, entries[0]!);
  for (const entry of requireDirectoryEntries(extracted)) renameSync(join(extracted, entry), join(root, entry));
  rmSync(extracted, { recursive: true, force: true });
}

function requireDirectoryEntries(path: string): string[] {
  return readdirSync(path);
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
