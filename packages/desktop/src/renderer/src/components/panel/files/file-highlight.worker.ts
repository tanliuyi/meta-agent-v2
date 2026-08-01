import type { HighlightResult, ThemeInput } from "@streamdown/code";
import { code as codeHighlighter } from "@streamdown/code";

interface HighlightRequest {
  id: number;
  code: string;
  language: string;
  themes: [ThemeInput, ThemeInput];
}

interface HighlightResponse {
  id: number;
  tokens: HighlightResult | null;
}

/** 不引入 WebWorker lib，避免与渲染进程 DOM lib 全局声明冲突。 */
type WorkerScope = {
  onmessage: ((event: MessageEvent<HighlightRequest>) => void) | null;
  postMessage(message: HighlightResponse): void;
};

const ctx = self as unknown as WorkerScope;

ctx.onmessage = (event: MessageEvent<HighlightRequest>) => {
  const { id, code, language, themes } = event.data;
  try {
    if (!codeHighlighter.supportsLanguage(language as Parameters<typeof codeHighlighter.supportsLanguage>[0])) {
      ctx.postMessage({ id, tokens: null });
      return;
    }
    const apply = (tokens: HighlightResult) => ctx.postMessage({ id, tokens });
    const immediate = codeHighlighter.highlight(
      {
        code,
        language: language as Parameters<typeof codeHighlighter.supportsLanguage>[0],
        themes,
      },
      apply,
    );
    if (immediate) apply(immediate);
  } catch (error) {
    console.error("[file-highlight] 高亮失败", error);
    ctx.postMessage({ id, tokens: null });
  }
};
