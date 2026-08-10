import type { AppUpdater, ProgressInfo, UpdateCheckResult, UpdateInfo } from "electron-updater";
import updaterPackage from "electron-updater";
import type { UpdaterState } from "../shared/updater-contracts.ts";

declare const __DESKTOP_UPDATE_URLS__: string;

const GITHUB_OWNER = "tanliuyi";
const GITHUB_REPO = "meta-agent-harness";
const INITIAL_CHECK_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;

// 注意：不要在此处顶层访问 updaterPackage.autoUpdater。electron-updater 的 autoUpdater
// 在非打包进程（electron-vite dev）中加载即崩溃（ElectronAppAdapter 访问 app.getVersion
// 时 app 未就绪），只能在确认 isPackaged 后再惰性获取。

type FeedConfiguration = Parameters<AppUpdater["setFeedURL"]>[0];

export interface UpdateSource {
  id: string;
  label: string;
  feed: FeedConfiguration;
}

interface UpdateApp {
  readonly isPackaged: boolean;
  getVersion(): string;
}

interface AutoUpdateServiceOptions {
  app: UpdateApp;
  updater?: AppUpdater;
  sources?: readonly UpdateSource[];
  platform?: NodeJS.Platform;
  arch?: string;
  log?: Pick<Console, "error" | "info">;
}

/** Owns updater state and preserves electron-updater verification across ordered download sources. */
export class AutoUpdateService {
  private state: UpdaterState;
  private updater: AppUpdater | undefined;
  private readonly app: UpdateApp;
  private readonly sources: readonly UpdateSource[];
  private readonly listeners = new Set<(state: UpdaterState) => void>();
  private readonly log: Pick<Console, "error" | "info">;
  private activeSourceIndex = 0;
  private checkOperation: Promise<void> | undefined;
  private downloadOperation: Promise<void> | undefined;

  constructor(options: AutoUpdateServiceOptions) {
    this.app = options.app;
    this.sources = options.sources ?? getDefaultUpdateSources();
    this.log = options.log ?? console;
    this.state = {
      status: options.app.isPackaged ? "idle" : "unsupported",
      currentVersion: options.app.getVersion(),
    };

    // 非打包进程（dev）不加载 electron-updater：其 autoUpdater getter 在加载时即崩溃。
    if (!options.app.isPackaged && options.updater === undefined) return;
    this.updater = options.updater ?? updaterPackage.autoUpdater;

    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = true;
    if ((options.platform ?? process.platform) === "darwin" && (options.arch ?? process.arch) === "arm64") {
      this.updater.channel = "latest-arm64";
    }

    this.updater.on("download-progress", (progress: ProgressInfo) => this.handleProgress(progress));
    this.updater.on("update-downloaded", (info: UpdateInfo) => {
      this.publish({
        status: "ready",
        availableVersion: info.version,
        percent: 100,
        error: undefined,
      });
    });
    this.updater.on("error", (error: Error) => {
      this.log.error("Auto-update source failed:", error);
    });
  }

  getState(): UpdaterState {
    return this.state;
  }

  subscribe(listener: (state: UpdaterState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  check(): Promise<void> {
    if (!this.app.isPackaged) {
      this.publish({ status: "unsupported" });
      return Promise.resolve();
    }
    if (this.downloadOperation) return this.downloadOperation;
    if (this.checkOperation) return this.checkOperation;

    const operation = this.checkAcrossSources().finally(() => {
      if (this.checkOperation === operation) this.checkOperation = undefined;
    });
    this.checkOperation = operation;
    return operation;
  }

  download(): Promise<void> {
    if (this.downloadOperation) return this.downloadOperation;
    if (this.state.status !== "available" || !this.state.availableVersion) {
      return Promise.reject(new Error("No update is available to download"));
    }

    const expectedVersion = this.state.availableVersion;
    const operation = this.downloadAcrossSources(expectedVersion).finally(() => {
      if (this.downloadOperation === operation) this.downloadOperation = undefined;
    });
    this.downloadOperation = operation;
    return operation;
  }

  install(): void {
    if (this.state.status !== "ready") throw new Error("The update has not finished downloading");
    setImmediate(() => this.updater!.quitAndInstall());
  }

  private async checkAcrossSources(): Promise<void> {
    this.publish({
      status: "checking",
      availableVersion: undefined,
      releaseNotes: undefined,
      percent: undefined,
      transferred: undefined,
      total: undefined,
      source: undefined,
      error: undefined,
    });
    const failures: string[] = [];

    for (let index = 0; index < this.sources.length; index += 1) {
      const source = this.sources[index];
      try {
        this.configureSource(index);
        const result = await this.updater!.checkForUpdates();
        if (!result) throw new Error("Update provider returned no result");
        if (!result.isUpdateAvailable) {
          this.publish({
            status: "up-to-date",
            source: source.label,
            error: undefined,
          });
          return;
        }
        this.activeSourceIndex = index;
        this.publishAvailable(result, source);
        return;
      } catch (error) {
        failures.push(`${source.label}: ${errorMessage(error)}`);
      }
    }

    this.reportFailure("检查更新失败", failures);
  }

  private async downloadAcrossSources(expectedVersion: string): Promise<void> {
    const failures: string[] = [];

    for (let index = this.activeSourceIndex; index < this.sources.length; index += 1) {
      const source = this.sources[index];
      try {
        if (index !== this.activeSourceIndex) {
          this.configureSource(index);
          const result = await this.updater!.checkForUpdates();
          if (!result?.isUpdateAvailable) throw new Error(`未提供版本 ${expectedVersion}`);
          if (result.updateInfo.version !== expectedVersion) {
            throw new Error(`版本不一致，期望 ${expectedVersion}，实际 ${result.updateInfo.version}`);
          }
        }

        this.activeSourceIndex = index;
        this.publish({
          status: "downloading",
          source: source.label,
          percent: 0,
          error: undefined,
        });
        await this.updater!.downloadUpdate();
        this.publish({
          status: "ready",
          source: source.label,
          availableVersion: expectedVersion,
          percent: 100,
        });
        return;
      } catch (error) {
        failures.push(`${source.label}: ${errorMessage(error)}`);
      }
    }

    this.reportFailure("下载更新失败", failures);
  }

  private configureSource(index: number): void {
    const source = this.sources[index];
    this.updater!.setFeedURL(source.feed);
    this.log.info(`Auto-update source: ${source.label}`);
  }

  private publishAvailable(result: UpdateCheckResult, source: UpdateSource): void {
    this.publish({
      status: "available",
      availableVersion: result.updateInfo.version,
      releaseNotes: serializeReleaseNotes(result.updateInfo.releaseNotes),
      source: source.label,
      error: undefined,
    });
  }

  private handleProgress(progress: ProgressInfo): void {
    this.publish({
      status: "downloading",
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
    });
  }

  private reportFailure(prefix: string, failures: readonly string[]): never {
    const error = new Error(`${prefix}：${failures.join("；")}`);
    this.publish({ status: "error", error: error.message });
    throw error;
  }

  private publish(patch: Partial<UpdaterState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}

export function getDefaultUpdateSources(rawUrls = compiledUpdateUrls()): UpdateSource[] {
  const sources: UpdateSource[] = parseUpdateUrls(rawUrls).map((url, index) => ({
    id: `mirror-${index + 1}`,
    label: sourceLabel(url, index),
    feed: { provider: "generic" as const, url },
  }));
  sources.push({
    id: "github",
    label: "GitHub Releases",
    feed: { provider: "github", owner: GITHUB_OWNER, repo: GITHUB_REPO },
  });
  return sources;
}

export function scheduleAutoUpdateChecks(service: AutoUpdateService): () => void {
  const check = (): void => {
    void service.check().catch(() => undefined);
  };
  const initialTimer = setTimeout(check, INITIAL_CHECK_DELAY_MS);
  const intervalTimer = setInterval(check, CHECK_INTERVAL_MS);
  return () => {
    clearTimeout(initialTimer);
    clearInterval(intervalTimer);
  };
}

function compiledUpdateUrls(): string {
  return typeof __DESKTOP_UPDATE_URLS__ === "string" ? __DESKTOP_UPDATE_URLS__ : "";
}

function parseUpdateUrls(raw: string): string[] {
  const value = raw.trim();
  if (!value) return [];

  let candidates: unknown;
  if (value.startsWith("[")) {
    try {
      candidates = JSON.parse(value);
    } catch {
      candidates = [];
    }
  } else {
    candidates = value.split(/[;\n]/);
  }
  if (!Array.isArray(candidates)) return [];

  const urls: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    try {
      const url = new URL(candidate.trim());
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      const normalized = `${url.href.replace(/\/+$/, "")}/`;
      if (!seen.has(normalized)) {
        seen.add(normalized);
        urls.push(normalized);
      }
    } catch {
      // Ignore malformed build-time mirror entries and retain the GitHub fallback.
    }
  }
  return urls;
}

function sourceLabel(url: string, index: number): string {
  try {
    return new URL(url).hostname || `更新源 ${index + 1}`;
  } catch {
    return `更新源 ${index + 1}`;
  }
}

function normalizeReleaseNote(note: string): string {
  return note
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((line) => line.trim())
    .filter((line, index, lines) => line.length > 0 && lines.indexOf(line) === index)
    .join("\n")
    .trim();
}

function serializeReleaseNotes(releaseNotes: UpdateInfo["releaseNotes"]): string | undefined {
  if (!releaseNotes) return undefined;
  const notes = typeof releaseNotes === "string" ? [releaseNotes] : releaseNotes.map((item) => item.note ?? "");
  const uniqueNotes = [...new Set(notes.map(normalizeReleaseNote).filter(Boolean))];
  return uniqueNotes.length > 0 ? uniqueNotes.join("\n\n") : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
