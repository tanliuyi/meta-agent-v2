import crypto from 'crypto';
import fs from 'fs';
import { homedir } from 'os';
import path from 'path';

export const FIGMA_CACHE_DIR = process.env.XDG_CACHE_HOME
  ? path.join(process.env.XDG_CACHE_HOME, 'pi', 'figma')
  : path.join(homedir(), '.cache', 'pi', 'figma');

export class FigmaCache {
  constructor(
    private readonly cacheDir = FIGMA_CACHE_DIR,
    private readonly maxEntries = 250,
  ) {}

  async get<T>(parts: unknown[]): Promise<T | null> {
    const file = this.fileFor(parts);
    try {
      const content = await fs.promises.readFile(file, 'utf8');
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }

  async set(parts: unknown[], value: unknown): Promise<void> {
    const file = this.fileFor(parts);
    await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(file, JSON.stringify(value), { mode: 0o600 });
    await this.evictOldEntries();
  }

  private fileFor(parts: unknown[]): string {
    const digest = crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
    return path.join(this.cacheDir, `${digest}.json`);
  }

  private async evictOldEntries(): Promise<void> {
    const entries = await fs.promises.readdir(this.cacheDir).catch(() => []);
    if (entries.length <= this.maxEntries) return;

    const files = await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map(async (entry) => {
          const file = path.join(this.cacheDir, entry);
          const stats = await fs.promises.stat(file);
          return { file, mtimeMs: stats.mtimeMs };
        }),
    );

    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    await Promise.all(files.slice(0, Math.max(0, files.length - this.maxEntries)).map((entry) => fs.promises.rm(entry.file)));
  }
}
