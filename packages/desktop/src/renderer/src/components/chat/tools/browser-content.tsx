import type { BrowserSnapshot, BrowserSnapshotNode } from "../../../../../shared/browser-contracts.ts";
import type { SessionImageResourceRef } from "../../../../../shared/contracts.ts";
import type { ToolResultContentProps } from "./tool-content-types.ts";
import { parseToolResult } from "./tool-format.ts";
import { ToolImage } from "./tool-image.tsx";
import { ToolResult } from "./tool-result.tsx";

/**
 * 内置浏览器工具（browser_*）卡片内容：URL/标题/快照摘要 + 截图缩略图
 * + 文本结果。数据来自工具结果 details（extension 侧写入 snapshot 与
 * screenshot），文本结果保持 ToolResult 渲染。
 */

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function countInteractiveNodes(tree: readonly BrowserSnapshotNode[] | undefined): number {
  if (!tree) return 0;
  let count = 0;
  const stack = [...tree];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.index !== undefined) count += 1;
    if (node.children) stack.push(...node.children);
  }
  return count;
}

function asSnapshot(value: unknown): BrowserSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.url !== "string" || !Array.isArray(value.tree)) return undefined;
  return value as unknown as BrowserSnapshot;
}

function asImageResourceRef(value: unknown): SessionImageResourceRef | undefined {
  if (!isRecord(value) || typeof value.resourceId !== "string" || typeof value.mimeType !== "string") return undefined;
  const unavailable =
    value.unavailable === "too-large" || value.unavailable === "budget-exceeded" ? value.unavailable : undefined;
  return { resourceId: value.resourceId, mimeType: value.mimeType, ...(unavailable ? { unavailable } : {}) };
}

/** 截图来源：内嵌 dataUrl 或历史 timeline 的图像资源引用。 */
export function asScreenshotSource(value: unknown): string | SessionImageResourceRef | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  if (typeof value.dataUrl === "string") return value.dataUrl;
  return asImageResourceRef(value.dataUrl) ?? asImageResourceRef(value);
}

/** 仅展示浏览器工具结果的组件。 */
export function BrowserContent({ result, error, expanded }: ToolResultContentProps) {
  if (!expanded && !error) return null;
  const parsed = parseToolResult(result);
  const details = parsed?.details;
  const snapshot = asSnapshot(details?.snapshot);
  const screenshot = asScreenshotSource(details?.screenshot) ?? snapshot?.screenshot ?? undefined;
  const interactiveCount = countInteractiveNodes(snapshot?.tree);
  const hasText = Boolean(parsed?.text.trim() || (parsed?.images?.length ?? 0) > 0);

  return (
    <div className="browser-tool-content">
      {snapshot ? (
        <div className="browser-snapshot-summary">
          {snapshot.title ? <span className="browser-snapshot-title">{snapshot.title}</span> : null}
          <span className="browser-snapshot-url">{snapshot.url}</span>
          {interactiveCount > 0 ? <span className="browser-snapshot-meta">{interactiveCount} 个可交互元素</span> : null}
        </div>
      ) : null}
      {screenshot ? (
        typeof screenshot === "string" ? (
          <img className="browser-screenshot" src={screenshot} alt="页面截图" />
        ) : (
          <ToolImage className="browser-screenshot" resource={screenshot} alt="页面截图" />
        )
      ) : null}
      {hasText ? <ToolResult result={result} error={error} expanded={expanded} previewLines={15} /> : null}
    </div>
  );
}
