import type { HighlightResult, ThemeInput } from "@streamdown/code";

interface HighlightResponse {
  id: number;
  tokens: HighlightResult | null;
}

/** undefined = 未初始化；null = 创建失败已禁用（回退纯文本）。 */
let worker: Worker | null | undefined;
let nextId = 0;
const pending = new Map<number, (tokens: HighlightResult | null) => void>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("./file-highlight.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<HighlightResponse>) => {
      const resolve = pending.get(event.data.id);
      pending.delete(event.data.id);
      resolve?.(event.data.tokens);
    };
    worker.onerror = () => {
      for (const resolve of pending.values()) resolve(null);
      pending.clear();
    };
  } catch {
    worker = null;
  }
  return worker;
}

/** 高亮超时后放弃等待（Worker 内部加载失败等场景），避免 pending 泄漏。 */
const HIGHLIGHT_TIMEOUT_MS = 15_000;

/** 在 Worker 中异步高亮代码；不支持的语言、Worker 不可用或失败时返回 null（保持纯文本）。 */
export function highlightFileCode(
  code: string,
  language: string,
  themes: [ThemeInput, ThemeInput],
): Promise<HighlightResult | null> {
  return new Promise((resolve) => {
    const target = getWorker();
    if (!target) {
      resolve(null);
      return;
    }
    const id = ++nextId;
    const timeout = window.setTimeout(() => {
      pending.delete(id);
      resolve(null);
    }, HIGHLIGHT_TIMEOUT_MS);
    pending.set(id, (tokens) => {
      window.clearTimeout(timeout);
      resolve(tokens);
    });
    target.postMessage({ id, code, language, themes });
  });
}
