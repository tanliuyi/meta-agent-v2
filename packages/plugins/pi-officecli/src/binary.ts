import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ResolvedOfficeCliConfig } from "./types.ts";

/**
 * Locate and, on first use, download the OfficeCLI binary.
 *
 * The binary is a single self-contained executable (Apache-2.0, published by
 * iOfficeAI at https://github.com/iOfficeAI/OfficeCLI). Download URLs mirror the
 * official installers: the d.officecli.ai mirror first, GitHub releases as
 * fallback, pinned to an immutable release tag. SHA256SUMS is verified when the
 * checksum file is reachable.
 */

const MIRROR_BASE = "https://d.officecli.ai";
const GITHUB_BASE = "https://github.com/iOfficeAI/OfficeCLI";
const USER_AGENT = "pi-officecli-plugin";

/** Map a platform/arch pair to the release asset name, or null when unsupported. */
export function detectAsset(platform: string, arch: string): string | null {
  if (platform === "darwin") {
    if (arch === "arm64") return "officecli-mac-arm64";
    if (arch === "x64") return "officecli-mac-x64";
  } else if (platform === "linux") {
    if (arch === "x64") return "officecli-linux-x64";
    if (arch === "arm64") return "officecli-linux-arm64";
  } else if (platform === "win32") {
    if (arch === "x64") return "officecli-win-x64.exe";
    if (arch === "arm64") return "officecli-win-arm64.exe";
  }
  return null;
}

export function binaryFileName(platform: string = process.platform): string {
  return platform === "win32" ? "officecli.exe" : "officecli";
}

/** Where the auto-downloaded binary lives on disk. */
export function binaryPathFor(config: ResolvedOfficeCliConfig): string {
  return path.join(config.dataDir, binaryFileName());
}

function assetUrls(asset: string, version: string): [string, string] {
  const tag = version.startsWith("v") ? version : `v${version}`;
  return [
    `${MIRROR_BASE}/releases/download/${tag}/${asset}`,
    `${GITHUB_BASE}/releases/download/${tag}/${asset}`,
  ];
}

function checksumUrls(asset: string, version: string): [string, string] {
  return assetUrls(asset, version).map((url) => url.replace(`/${asset}`, "/SHA256SUMS")) as [string, string];
}

async function fetchWithTimeout(url: string, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`download timeout after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => controller.abort(new Error("download aborted"));
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function fetchBuffer(url: string, timeoutMs: number, signal?: AbortSignal): Promise<Buffer> {
  const res = await fetchWithTimeout(url, timeoutMs, signal);
  return Buffer.from(await res.arrayBuffer());
}

/** Expected SHA256 hex for the asset, or null when the checksum file is unreachable. */
export async function fetchExpectedChecksum(asset: string, version: string, signal?: AbortSignal): Promise<string | null> {
  for (const url of checksumUrls(asset, version)) {
    try {
      const text = (await fetchBuffer(url, 30_000, signal)).toString("utf8");
      for (const line of text.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          const name = parts[1].replace(/^\*/, "");
          if (name === asset) return parts[0].toLowerCase();
        }
      }
      return null;
    } catch {
      // Try the next source.
    }
  }
  return null;
}

let downloadPromise: Promise<string> | null = null;

/**
 * Return a usable binary path, downloading it on first use.
 *
 * - `binaryPath` from config wins and is never downloaded.
 * - An existing file in `dataDir` is reused as-is.
 * - Otherwise the platform binary is downloaded to `dataDir` (mirror, then
 *   GitHub), checksum-verified when possible, and sanity-checked via
 *   `--version`.
 */
export function ensureBinary(config: ResolvedOfficeCliConfig, signal?: AbortSignal): Promise<string> {
  if (config.binaryPath) {
    if (!existsSync(config.binaryPath)) {
      return Promise.reject(new Error(`binaryPath 指向的文件不存在: ${config.binaryPath}`));
    }
    return Promise.resolve(config.binaryPath);
  }
  const target = binaryPathFor(config);
  if (existsSync(target) && statSync(target).size > 1_000_000) {
    return Promise.resolve(target);
  }
  if (!config.autoDownload) {
    return Promise.reject(
      new Error(
        "未找到 officecli 二进制，且 autoDownload 已关闭。请安装 OfficeCLI 后重试，或设置 binaryPath 指向已安装的二进制。",
      ),
    );
  }
  downloadPromise ??= downloadBinary(config, target, signal).finally(() => {
    downloadPromise = null;
  });
  return downloadPromise;
}

async function downloadBinary(config: ResolvedOfficeCliConfig, target: string, signal?: AbortSignal): Promise<string> {
  const asset = detectAsset(process.platform, process.arch);
  if (!asset) {
    throw new Error(`不支持的平台 ${process.platform}/${process.arch}，请从 GitHub Releases 手动下载 officecli 并配置 binaryPath。`);
  }
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.download-${process.pid}`;
  let lastError: unknown = null;
  for (const url of assetUrls(asset, config.version)) {
    try {
      const buffer = await fetchBuffer(url, 300_000, signal);
      const expected = await fetchExpectedChecksum(asset, config.version, signal);
      if (expected && createHash("sha256").update(buffer).digest("hex") !== expected) {
        throw new Error(`SHA256 校验失败: ${asset}（期望 ${expected}）`);
      }
      writeFileSync(tmp, buffer);
      if (process.platform !== "win32") chmodSync(tmp, 0o755);
      renameSync(tmp, target);
      verifyBinary(target);
      return target;
    } catch (error) {
      lastError = error;
      rmSync(tmp, { force: true });
    }
  }
  throw new Error(
    `无法下载 OfficeCLI ${config.version}（${asset}）。镜像与 GitHub Releases 均失败: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

function verifyBinary(target: string): void {
  const res = spawnSync(target, ["--version"], { timeout: 30_000, windowsHide: true });
  if (res.error || res.status !== 0) {
    rmSync(target, { force: true });
    throw new Error(`下载的 officecli 二进制无法运行: ${res.error?.message ?? res.stderr?.toString() ?? `exit ${res.status}`}`);
  }
}
