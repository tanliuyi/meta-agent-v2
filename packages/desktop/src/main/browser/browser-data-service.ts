/**
 * 内置浏览器用户数据服务：读写 userDataDir/browser-data.json 与
 * userDataDir/browser-passwords.json。
 *
 * 与 browser-settings-service 同构：lstat 拒 symlink、proper-lockfile、
 * 临时文件 rename 原子写、串行保存队列。浏览历史 / 下载历史 / 联系信息 /
 * 网站设置明文存于 browser-data.json；保存的密码经系统安全存储
 * （safeStorage）加密后存于 browser-passwords.json。
 */

import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import type {
  BrowserContactInput,
  BrowserDataMutateResult,
  BrowserDataSnapshot,
  BrowserDownloadState,
  BrowserPasswordInput,
  BrowserSitePermission,
  BrowserSitePermissionInput,
  ContactProfile,
  PersistedDownload,
  PersistedHistoryEntry,
  SavedPassword,
} from "../../shared/browser-data-contracts.ts";
import {
  MAX_PERSISTED_DOWNLOADS,
  MAX_PERSISTED_HISTORY,
  normalizeBrowserDataSnapshot,
} from "../../shared/browser-data-contracts.ts";
import { normalizeSitePattern } from "../../shared/browser-site-policy.ts";

/** 同 URL 历史条目合并窗口（毫秒）。 */
const HISTORY_MERGE_WINDOW_MS = 30 * 60 * 1000;

interface BrowserDataFile {
  history: PersistedHistoryEntry[];
  downloads: PersistedDownload[];
  contacts: ContactProfile[];
  sitePermissions: BrowserSitePermission[];
}

interface StoredPasswordEntry {
  id: string;
  origin: string;
  username: string;
  /** base64 密文。 */
  cipher: string;
  createdAt: number;
  updatedAt: number;
}

interface StoredPasswordFile {
  entries: StoredPasswordEntry[];
}

export interface BrowserCrypto {
  isAvailable(): boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}

interface BrowserDataServiceOptions {
  createId?(): string;
  /** 覆盖默认 userDataDir/browser-data.json（测试用）。 */
  path?: string;
  /** 覆盖默认 userDataDir/browser-passwords.json（测试用）。 */
  passwordsPath?: string;
  /** 系统安全存储回调（safeStorage）。缺省时密码功能禁用。 */
  crypto?: BrowserCrypto;
  log?(text: string): void;
}

/** Desktop 内置浏览器的用户数据服务。 */
export class BrowserDataService {
  readonly path: string;
  readonly passwordsPath: string;
  private readonly createId: () => string;
  private readonly crypto?: BrowserCrypto;
  private readonly log: (text: string) => void;
  private dataTail: Promise<void> = Promise.resolve();
  private passwordsTail: Promise<void> = Promise.resolve();

  constructor(userDataDir: string, options: BrowserDataServiceOptions = {}) {
    this.path = options.path ?? join(userDataDir, "browser-data.json");
    this.passwordsPath = options.passwordsPath ?? join(userDataDir, "browser-passwords.json");
    this.createId = options.createId ?? randomUUID;
    this.crypto = options.crypto;
    this.log = options.log ?? (() => undefined);
  }

  getSnapshot(): Promise<BrowserDataSnapshot> {
    const operation = this.dataTail.then(() => this.readDataFile());
    this.dataTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation.then(async (data) => ({
      history: data.history,
      downloads: data.downloads,
      contacts: data.contacts,
      sitePermissions: data.sitePermissions,
      passwords: await this.readPasswordsPlain(),
    }));
  }

  /** 记录一次页面访问；与现有条目同 URL 且在合并窗口内时更新时间戳与标题。 */
  recordHistory(url: string, title: string): Promise<void> {
    return this.mutateDataFile((data) => {
      const now = Date.now();
      const first = data.history[0];
      if (first && first.url === url && now - first.timestamp < HISTORY_MERGE_WINDOW_MS) {
        data.history[0] = { url, title, timestamp: now };
      } else {
        data.history.unshift({ url, title, timestamp: now });
        if (data.history.length > MAX_PERSISTED_HISTORY) {
          data.history.length = MAX_PERSISTED_HISTORY;
        }
      }
    });
  }

  /** 更新最近一条指定 URL 的标题，不改变访问时间。 */
  updateLatestHistoryTitle(url: string, title: string): Promise<void> {
    return this.mutateDataFile((data) => {
      const index = data.history.findIndex((entry) => entry.url === url);
      if (index === -1) return;
      data.history[index] = { ...data.history[index]!, title };
    });
  }

  /** 删除单条历史记录（按 url + timestamp 精确匹配）。 */
  deleteHistoryEntry(url: string, timestamp: number): Promise<BrowserDataMutateResult> {
    const result = this.mutateDataFile((data) => {
      data.history = data.history.filter((entry) => !(entry.url === url && entry.timestamp === timestamp));
    });
    return this.toMutateResult(result);
  }

  clearHistory(): Promise<BrowserDataMutateResult> {
    const result = this.mutateDataFile((data) => {
      data.history = [];
    });
    return this.toMutateResult(result);
  }

  /** 记录一次下载的结束状态。 */
  recordDownload(input: {
    url: string;
    filename: string;
    path: string | null;
    totalBytes: number;
    receivedBytes: number;
    state: BrowserDownloadState;
    startedAt: number;
    endedAt: number | null;
  }): Promise<void> {
    return this.mutateDataFile((data) => {
      data.downloads.unshift({
        id: this.createId(),
        url: input.url,
        filename: input.filename,
        path: input.path,
        totalBytes: input.totalBytes,
        receivedBytes: input.receivedBytes,
        state: input.state,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
      });
      if (data.downloads.length > MAX_PERSISTED_DOWNLOADS) {
        data.downloads.length = MAX_PERSISTED_DOWNLOADS;
      }
    });
  }

  clearDownloads(): Promise<BrowserDataMutateResult> {
    const result = this.mutateDataFile((data) => {
      data.downloads = [];
    });
    return this.toMutateResult(result);
  }

  saveContact(input: { contactId: string | null; contact: BrowserContactInput }): Promise<BrowserDataMutateResult> {
    const result = this.mutateDataFile((data) => {
      const now = Date.now();
      if (input.contactId) {
        const existing = data.contacts.find((contact) => contact.id === input.contactId);
        if (existing) {
          data.contacts = data.contacts.map((contact) =>
            contact.id === input.contactId ? { ...contact, ...input.contact, updatedAt: now } : contact,
          );
          return;
        }
      }
      data.contacts.unshift({ ...input.contact, id: this.createId(), createdAt: now, updatedAt: now });
    });
    return this.toMutateResult(result);
  }

  deleteContact(id: string): Promise<BrowserDataMutateResult> {
    const result = this.mutateDataFile((data) => {
      data.contacts = data.contacts.filter((contact) => contact.id !== id);
    });
    return this.toMutateResult(result);
  }

  savePassword(input: { passwordId: string | null; password: BrowserPasswordInput }): Promise<BrowserDataMutateResult> {
    if (!this.crypto || !this.crypto.isAvailable()) {
      return Promise.resolve({ ok: false, error: "系统安全存储不可用，无法保存密码。" });
    }
    const plain = {
      origin: input.password.origin,
      username: input.password.username,
      password: input.password.password,
    };
    const cipher = this.crypto.encrypt(`${plain.origin}\u0000${plain.username}\u0000${plain.password}`);
    const result = this.mutatePasswordsFile((data) => {
      const now = Date.now();
      if (input.passwordId) {
        const existing = data.entries.find((entry) => entry.id === input.passwordId);
        if (existing) {
          data.entries = data.entries.map((entry) =>
            entry.id === input.passwordId
              ? {
                  id: entry.id,
                  origin: plain.origin,
                  username: plain.username,
                  cipher,
                  createdAt: entry.createdAt,
                  updatedAt: now,
                }
              : entry,
          );
          return;
        }
      }
      data.entries.unshift({
        id: this.createId(),
        origin: plain.origin,
        username: plain.username,
        cipher,
        createdAt: now,
        updatedAt: now,
      });
    });
    return this.toMutateResult(result);
  }

  deletePassword(id: string): Promise<BrowserDataMutateResult> {
    const result = this.mutatePasswordsFile((data) => {
      data.entries = data.entries.filter((entry) => entry.id !== id);
    });
    return this.toMutateResult(result);
  }

  saveSitePermission(input: BrowserSitePermissionInput): Promise<BrowserDataMutateResult> {
    const site = normalizeSitePattern(input.site);
    if (!site) {
      return Promise.resolve({ ok: false, error: `无效的站点：${input.site}` });
    }
    const result = this.mutateDataFile((data) => {
      const now = Date.now();
      const existing = data.sitePermissions.find((entry) => entry.site === site && entry.kind === input.kind);
      if (existing) {
        data.sitePermissions = data.sitePermissions.map((entry) =>
          entry.id === existing.id ? { ...entry, value: input.value, updatedAt: now } : entry,
        );
        return;
      }
      data.sitePermissions.unshift({ id: this.createId(), site, kind: input.kind, value: input.value, updatedAt: now });
    });
    return this.toMutateResult(result);
  }

  deleteSitePermission(id: string): Promise<BrowserDataMutateResult> {
    const result = this.mutateDataFile((data) => {
      data.sitePermissions = data.sitePermissions.filter((entry) => entry.id !== id);
    });
    return this.toMutateResult(result);
  }

  /** 供设置服务读取网站设置覆盖（browser-manager 权限 handler 用）。 */
  async listSitePermissions(): Promise<BrowserSitePermission[]> {
    const data = await this.readDataFile();
    return data.sitePermissions;
  }

  private async toMutateResult(operation: Promise<void>): Promise<BrowserDataMutateResult> {
    try {
      await operation;
      return { ok: true, snapshot: await this.getSnapshot() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`browser data mutate failed: ${message}`);
      return { ok: false, error: "数据保存失败。" };
    }
  }

  private mutateDataFile(mutate: (data: BrowserDataFile) => void): Promise<void> {
    const operation = this.dataTail.then(() => this.mutateDataFileLocked(mutate));
    this.dataTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async mutateDataFileLocked(mutate: (data: BrowserDataFile) => void): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.path, {
      realpath: false,
      stale: 30_000,
      retries: { retries: 6, factor: 1.6, minTimeout: 50, maxTimeout: 500, randomize: true },
    });
    try {
      const data = await this.readDataFile();
      mutate(data);
      await this.atomicWrite(this.path, `.browser-data.json`, data);
    } finally {
      await release();
    }
  }

  private mutatePasswordsFile(mutate: (data: StoredPasswordFile) => void): Promise<void> {
    const operation = this.passwordsTail.then(() => this.mutatePasswordsFileLocked(mutate));
    this.passwordsTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async mutatePasswordsFileLocked(mutate: (data: StoredPasswordFile) => void): Promise<void> {
    await mkdir(dirname(this.passwordsPath), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.passwordsPath, {
      realpath: false,
      stale: 30_000,
      retries: { retries: 6, factor: 1.6, minTimeout: 50, maxTimeout: 500, randomize: true },
    });
    try {
      const data = await this.readPasswordsFile();
      mutate(data);
      await this.atomicWrite(this.passwordsPath, `.browser-passwords.json`, data);
    } finally {
      await release();
    }
  }

  private async readDataFile(): Promise<BrowserDataFile> {
    const snapshot = normalizeBrowserDataSnapshot(await this.readJsonFile(this.path));
    return {
      history: snapshot.history,
      downloads: snapshot.downloads,
      contacts: snapshot.contacts,
      sitePermissions: snapshot.sitePermissions,
    };
  }

  private async readPasswordsFile(): Promise<StoredPasswordFile> {
    const value = await this.readJsonFile(this.passwordsPath);
    const entries: StoredPasswordEntry[] = [];
    const rawEntries =
      typeof value === "object" && value !== null ? (value as Record<string, unknown>).entries : undefined;
    if (Array.isArray(rawEntries)) {
      for (const raw of rawEntries) {
        if (typeof raw !== "object" || raw === null) continue;
        const entry = raw as Record<string, unknown>;
        if (typeof entry.id !== "string" || entry.id.length === 0) continue;
        if (
          typeof entry.origin !== "string" ||
          typeof entry.username !== "string" ||
          typeof entry.cipher !== "string"
        ) {
          continue;
        }
        entries.push({
          id: entry.id,
          origin: entry.origin,
          username: entry.username,
          cipher: entry.cipher,
          createdAt: typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
          updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now(),
        });
      }
    }
    return { entries };
  }

  /** 解密全部密码（密码管理器 UI 使用；safeStorage 不可用时返回空列表）。 */
  private async readPasswordsPlain(): Promise<SavedPassword[]> {
    if (!this.crypto || !this.crypto.isAvailable()) return [];
    const file = await this.readPasswordsFile();
    const plain: SavedPassword[] = [];
    for (const entry of file.entries) {
      try {
        const decrypted = this.crypto.decrypt(entry.cipher);
        const [origin, username, password] = decrypted.split("\u0000");
        if (!origin || !username || password === undefined) continue;
        plain.push({
          id: entry.id,
          origin,
          username,
          password,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        });
      } catch {
        this.log(`browser password decrypt failed for ${entry.id}`);
      }
    }
    return plain;
  }

  private async readJsonFile(path: string): Promise<unknown> {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`Refusing to read symlink: ${path}`);
      if (!info.isFile()) throw new Error(`${path} is not a regular file`);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
    const bytes = await readFile(path);
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      this.log(`${path} JSON syntax invalid, ignoring`);
      return undefined;
    }
  }

  private async atomicWrite(path: string, tempPrefix: string, data: unknown): Promise<void> {
    const directory = dirname(path);
    const source = `${JSON.stringify(data, null, 2)}\n`;
    const tempPath = join(directory, `${tempPrefix}.${process.pid}.${this.createId()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(source, "utf8");
      await handle.sync();
      await handle.chmod(0o600);
      await handle.close();
      handle = undefined;
      await rename(tempPath, path);
      try {
        await chmod(path, 0o600);
      } catch {
        // best-effort
      }
      if (process.platform !== "win32") {
        try {
          const directoryHandle = await open(directory, "r");
          try {
            await directoryHandle.sync();
          } finally {
            await directoryHandle.close();
          }
        } catch {
          // best-effort
        }
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
