/**
 * 页面快照的模型侧文本渲染与 spill 处理（spec §7.2）。
 *
 * 文本树以可交互元素编号定位（`[N] role name`），缩进反映层级；超过阈值
 * 的整棵树写入系统临时文件，结果只给摘要与路径，避免上下文膨胀。
 */

import { readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserSnapshot, BrowserSnapshotNode } from "../../../../../shared/browser-contracts.ts";

/** 超过该长度时整体写入 spill 文件。 */
export const MAX_SNAPSHOT_TEXT = 4000;

/** spill 文件名前缀（清理时按此前缀匹配）。 */
export const SPILL_FILE_PREFIX = "pi-browser-snapshot-";

/** 溢出快照超过该数量时删除最旧文件。 */
export const MAX_SPILL_FILES = 100;

/** 溢出快照超过该年龄（毫秒）时删除。 */
export const SPILL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface RenderedSnapshot {
  text: string;
  /** spill 文件绝对路径；未溢出时为 null。 */
  spilledPath: string | null;
}

/** 渲染快照树为文本（编号 + role + name + 关键属性）。 */
export function renderSnapshotText(snapshot: BrowserSnapshot): string {
  const lines: string[] = [];
  for (const node of snapshot.tree) renderNode(node, 0, lines);
  return lines.join("\n");
}

/** 渲染并处理溢出：超限时写 spill 文件并截断摘要。 */
export async function spillSnapshotText(snapshot: BrowserSnapshot): Promise<RenderedSnapshot> {
  const full = renderSnapshotText(snapshot);
  if (full.length <= MAX_SNAPSHOT_TEXT) return { text: full, spilledPath: null };
  const path = join(tmpdir(), `${SPILL_FILE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  await writeFile(path, full, "utf8");
  // 清理旧 spill（不阻塞快照返回）。
  void cleanupOldSpills().catch(() => undefined);
  return {
    text: `${full.slice(0, MAX_SNAPSHOT_TEXT)}\n…（快照过长，已写入 ${path}，可用 read 工具读取）`,
    spilledPath: path,
  };
}

/** 清理过期/超量的 spill 文件：删除超过 24h 的文件，以及数量超过上限时最旧的文件。
 *  失败静默（best-effort），返回删除的文件数。 */
export async function cleanupOldSpills(dir: string = tmpdir()): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith(SPILL_FILE_PREFIX) || !name.endsWith(".txt")) continue;
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      candidates.push({ path, mtimeMs: info.mtimeMs });
    } catch {
      // 文件已消失或不可读：跳过。
    }
  }
  const expired = candidates.filter((candidate) => now - candidate.mtimeMs > SPILL_MAX_AGE_MS);
  const fresh = candidates
    .filter((candidate) => now - candidate.mtimeMs <= SPILL_MAX_AGE_MS)
    .sort((left, right) => left.mtimeMs - right.mtimeMs);
  const excess = fresh.length > MAX_SPILL_FILES ? fresh.slice(0, fresh.length - MAX_SPILL_FILES) : [];
  let removed = 0;
  for (const candidate of [...expired, ...excess]) {
    try {
      await rm(candidate.path, { force: true });
      removed += 1;
    } catch {
      // 删除失败不影响其他清理。
    }
  }
  return removed;
}

function renderNode(node: BrowserSnapshotNode, depth: number, lines: string[]): void {
  const indent = "  ".repeat(depth);
  const index = node.index !== undefined ? `[${node.index}] ` : "";
  const value = node.value !== undefined && node.value.length > 0 ? ` value="${node.value}"` : "";
  lines.push(`${indent}${index}${node.role} ${node.name}${value}${formatAttrs(node)}`);
  for (const child of node.children ?? []) renderNode(child, depth + 1, lines);
}

function formatAttrs(node: BrowserSnapshotNode): string {
  const parts: string[] = [];
  if (node.attrs?.href !== undefined) parts.push(`href=${node.attrs.href}`);
  if (node.attrs?.type !== undefined) parts.push(`type=${node.attrs.type}`);
  if (node.attrs?.checked === true) parts.push("checked");
  if (node.attrs?.selected === true) parts.push("selected");
  if (node.selector !== undefined) parts.push(`sel=${node.selector}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}
