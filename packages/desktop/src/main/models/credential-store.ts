/**
 * Desktop-owned file-backed CredentialStore.
 *
 * Implements pi-ai's public CredentialStore interface, using proper-lockfile
 * for atomic writes to auth.json. Reads the file on every modify/delete so
 * external edits are observed. Does not depend on coding-agent internals.
 */

import { execSync, spawnSync } from "node:child_process";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";

type AuthFileData = Record<string, Credential>;

/** @internal For Desktop use only; not exported from the package. */
export class FileCredentialStore implements CredentialStore {
  private readonly authPath: string;
  private readonly log: (message: string) => void;

  constructor(authPath: string, log: (message: string) => void = console.error) {
    this.authPath = authPath;
    this.log = log;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const data = await this.readAll();
    const credential = data[providerId];
    if (credential?.type !== "api_key" || credential.key === undefined) return credential;
    return { ...credential, key: resolveCredentialValue(credential.key, credential.env) };
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const data = await this.readAll();
    return Object.entries(data).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.locked(async (data) => {
      const current = data[providerId];
      const next = await fn(current);
      if (next !== undefined) data[providerId] = next;
      return next ?? current;
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.locked(async (data) => {
      delete data[providerId];
    });
  }

  private async readAll(): Promise<AuthFileData> {
    try {
      const bytes = await readFile(this.authPath, "utf-8");
      return JSON.parse(bytes) as AuthFileData;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  private async locked<T>(fn: (data: AuthFileData) => Promise<T>): Promise<T> {
    await mkdir(dirname(this.authPath), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.authPath, {
      realpath: false,
      stale: 30_000,
      retries: { retries: 6, factor: 1.6, minTimeout: 50, maxTimeout: 500, randomize: true },
    });
    try {
      const data = await this.readAll();
      const result = await fn(data);
      const json = `${JSON.stringify(data, null, 2)}\n`;
      const tempPath = `${this.authPath}.${process.pid}.tmp`;
      const handle = await open(tempPath, "wx", 0o600);
      try {
        await handle.writeFile(json, "utf8");
        await handle.sync();
        await handle.chmod(0o600);
        await handle.close();
        await rename(tempPath, this.authPath);
        try {
          await chmod(this.authPath, 0o600);
        } catch (error) {
          this.log(`auth credential store: post-rename chmod failed: ${String(error)}`);
        }
        if (process.platform !== "win32") {
          try {
            const directory = await open(dirname(this.authPath), "r");
            try {
              await directory.sync();
            } finally {
              await directory.close();
            }
          } catch (error) {
            this.log(`auth credential store: post-rename dir fsync failed: ${String(error)}`);
          }
        }
      } finally {
        await rm(tempPath, { force: true }).catch(() => {});
      }
      return result;
    } finally {
      await release().catch(() => {});
    }
  }
}

const commandResultCache = new Map<string, string | undefined>();
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*/;

function resolveCredentialValue(config: string, env?: Record<string, string>): string | undefined {
  if (config.startsWith("!")) return executeCommand(config);

  let resolved = "";
  let index = 0;
  while (index < config.length) {
    const dollarIndex = config.indexOf("$", index);
    if (dollarIndex < 0) return resolved + config.slice(index);
    resolved += config.slice(index, dollarIndex);
    const next = config[dollarIndex + 1];
    if (next === "$" || next === "!") {
      resolved += next;
      index = dollarIndex + 2;
      continue;
    }
    if (next === "{") {
      const close = config.indexOf("}", dollarIndex + 2);
      if (close >= 0) {
        const name = config.slice(dollarIndex + 2, close);
        if (ENV_VAR_NAME.test(name)) {
          const value = env?.[name] || process.env[name];
          if (!value) return undefined;
          resolved += value;
          index = close + 1;
          continue;
        }
        resolved += config.slice(dollarIndex, close + 1);
        index = close + 1;
        continue;
      }
    } else {
      const match = config.slice(dollarIndex + 1).match(ENV_VAR_PREFIX);
      if (match) {
        const value = env?.[match[0]] || process.env[match[0]];
        if (!value) return undefined;
        resolved += value;
        index = dollarIndex + 1 + match[0].length;
        continue;
      }
    }
    resolved += "$";
    index = dollarIndex + 1;
  }
  return resolved;
}

function executeCommand(config: string): string | undefined {
  if (commandResultCache.has(config)) return commandResultCache.get(config);
  const command = config.slice(1);
  let result: string | undefined;
  if (process.platform === "win32") {
    try {
      const { shell, args, commandTransport } = getShellConfig();
      const stdin = commandTransport === "stdin";
      const execution = spawnSync(shell, stdin ? args : [...args, command], {
        encoding: "utf8",
        input: stdin ? command : undefined,
        timeout: 10_000,
        stdio: [stdin ? "pipe" : "ignore", "pipe", "ignore"],
        shell: false,
        windowsHide: true,
      });
      if (!execution.error && execution.status === 0) result = execution.stdout.trim() || undefined;
      if ((execution.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT")
        result = executeDefaultShell(command);
    } catch {
      result = executeDefaultShell(command);
    }
  } else {
    result = executeDefaultShell(command);
  }
  commandResultCache.set(config, result);
  return result;
}

function executeDefaultShell(command: string): string | undefined {
  try {
    return (
      execSync(command, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}
