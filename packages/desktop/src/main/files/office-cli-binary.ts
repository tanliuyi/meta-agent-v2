import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

const MIRROR_BASE = "https://d.officecli.ai";
const GITHUB_BASE = "https://github.com/iOfficeAI/OfficeCLI";
const DEFAULT_VERSION = "v1.0.143";
const MAX_BINARY_BYTES = 128 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 300_000;
const CHECKSUM_TIMEOUT_MS = 30_000;
const activeInstalls = new Map<string, Promise<string>>();

export interface OfficeCliLocationConfiguration {
  installed?: boolean;
  binaryPath?: string;
  dataDir?: string;
  version?: string;
  autoDownload?: boolean;
}

export async function resolveOfficeCliBinary(
  configuration: OfficeCliLocationConfiguration = {},
): Promise<string | undefined> {
  const executable = officeCliFileName();
  const candidates = [
    configuration.binaryPath ? resolve(configuration.binaryPath) : undefined,
    configuration.dataDir ? join(resolve(configuration.dataDir), executable) : undefined,
    join(defaultOfficeCliDataDir(), executable),
    ...String(process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, executable)),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {
      // 继续检查下一个候选。
    }
  }
  return undefined;
}

/** 仅为已安装且允许自动下载的插件初始化 OfficeCLI。 */
export async function installOfficeCliBinary(configuration: OfficeCliLocationConfiguration): Promise<string> {
  if (!configuration.installed) throw new Error("请先安装并启用 pi-officecli 插件");
  if (configuration.autoDownload === false) {
    throw new Error("pi-officecli 已关闭自动下载。请配置 binaryPath，或在插件设置中开启自动下载");
  }
  const asset = officeCliAsset(process.platform, process.arch);
  if (!asset) throw new Error(`OfficeCLI 不支持当前平台 ${process.platform}/${process.arch}`);
  const version = normalizeVersion(configuration.version);
  const target = join(
    configuration.dataDir ? resolve(configuration.dataDir) : defaultOfficeCliDataDir(),
    officeCliFileName(),
  );
  const existing = activeInstalls.get(target);
  if (existing) return existing;
  const install = downloadOfficeCli(target, asset, version).finally(() => activeInstalls.delete(target));
  activeInstalls.set(target, install);
  return install;
}

function defaultOfficeCliDataDir(): string {
  return join(homedir(), ".pi", "agent", "officecli");
}

function officeCliFileName(): string {
  return process.platform === "win32" ? "officecli.exe" : "officecli";
}

function officeCliAsset(platform: NodeJS.Platform, arch: string): string | undefined {
  if (platform === "darwin" && arch === "arm64") return "officecli-mac-arm64";
  if (platform === "darwin" && arch === "x64") return "officecli-mac-x64";
  if (platform === "linux" && arch === "arm64") return "officecli-linux-arm64";
  if (platform === "linux" && arch === "x64") return "officecli-linux-x64";
  if (platform === "win32" && arch === "arm64") return "officecli-win-arm64.exe";
  if (platform === "win32" && arch === "x64") return "officecli-win-x64.exe";
  return undefined;
}

function normalizeVersion(version: string | undefined): string {
  const normalized = version?.trim() || DEFAULT_VERSION;
  const tagged = normalized.startsWith("v") ? normalized : `v${normalized}`;
  if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(tagged)) {
    throw new Error(`OfficeCLI 版本格式无效: ${normalized}`);
  }
  return tagged;
}

async function downloadOfficeCli(target: string, asset: string, version: string): Promise<string> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.download-${process.pid}-${randomUUID()}`;
  let lastError: unknown;
  try {
    for (const baseUrl of [MIRROR_BASE, GITHUB_BASE]) {
      const assetUrl = `${baseUrl}/releases/download/${version}/${asset}`;
      try {
        const binary = await fetchBuffer(assetUrl, DOWNLOAD_TIMEOUT_MS, MAX_BINARY_BYTES);
        const expectedChecksum = await fetchExpectedChecksum(baseUrl, version, asset);
        if (expectedChecksum && createHash("sha256").update(binary).digest("hex") !== expectedChecksum) {
          throw new Error(`SHA256 校验失败: ${asset}`);
        }
        await writeFile(temporary, binary, { mode: 0o755 });
        if (process.platform !== "win32") await chmod(temporary, 0o755);
        await verifyOfficeCli(temporary);
        await rename(temporary, target);
        return target;
      } catch (error) {
        lastError = error;
        await rm(temporary, { force: true });
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  throw new Error(
    `无法下载 OfficeCLI ${version}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function fetchExpectedChecksum(baseUrl: string, version: string, asset: string): Promise<string | undefined> {
  try {
    const checksumUrl = `${baseUrl}/releases/download/${version}/SHA256SUMS`;
    const text = (await fetchBuffer(checksumUrl, CHECKSUM_TIMEOUT_MS, MAX_CHECKSUM_BYTES)).toString("utf8");
    for (const line of text.split("\n")) {
      const [hash, rawName] = line.trim().split(/\s+/u);
      if (hash && rawName?.replace(/^\*/u, "") === asset && /^[a-f0-9]{64}$/iu.test(hash)) {
        return hash.toLowerCase();
      }
    }
  } catch {
    // 与插件保持一致：checksum 服务不可用时继续使用 HTTPS 下载。
  }
  return undefined;
}

async function fetchBuffer(url: string, timeoutMs: number, maxBytes: number): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "meta-agent-desktop" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error("下载内容超过大小限制");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error("下载内容超过大小限制");
    return buffer;
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyOfficeCli(binary: string): Promise<void> {
  await new Promise<void>((resolveVerify, rejectVerify) => {
    const child = spawn(binary, ["--version"], { stdio: "ignore", windowsHide: true });
    const timeout = setTimeout(() => child.kill(), CHECKSUM_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectVerify(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveVerify();
      else rejectVerify(new Error(`下载的 OfficeCLI 无法运行（exit: ${code ?? "unknown"}）`));
    });
  });
}
