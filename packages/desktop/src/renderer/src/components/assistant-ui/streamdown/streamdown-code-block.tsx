import { TooltipIconButton } from "@renderer/components/assistant-ui/tooltip-icon-button";
import { code as codeHighlighter, type HighlightResult } from "@streamdown/code";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import Download from "lucide-react/dist/esm/icons/download.mjs";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { CodeLine } from "./streamdown-code-line.tsx";
import { SHIKI_THEMES } from "./streamdown-config.ts";

const FILE_EXTENSIONS: Readonly<Record<string, string>> = {
  bash: "sh",
  css: "css",
  diff: "diff",
  html: "html",
  javascript: "js",
  js: "js",
  json: "json",
  jsx: "jsx",
  markdown: "md",
  md: "md",
  python: "py",
  sh: "sh",
  shell: "sh",
  ts: "ts",
  tsx: "tsx",
  typescript: "ts",
  yaml: "yaml",
  yml: "yml",
};

type CodeLanguage = Parameters<typeof codeHighlighter.supportsLanguage>[0];

interface HighlightedCode {
  code: string;
  language: string;
  result: HighlightResult;
}

export function MarkdownCodeBlock({ code, language }: { code: string; language: string }) {
  const highlighted = useHighlightedCode(code, language);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  const lines = resolveHighlightedTokens(highlighted, code, language) ?? plainTokens(code);
  const languageLabel = language || "text";
  const lineNumberWidth = `${Math.max(2, String(lines.length).length)}ch`;

  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const copyCode = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 2_000);
  };

  const downloadCode = () => {
    const extension = (FILE_EXTENSIONS[language] ?? language.replace(/[^a-z0-9.+-]/g, "")) || "txt";
    const url = URL.createObjectURL(new Blob([code], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `snippet.${extension}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="markdown-code-block" data-language={languageLabel} data-streamdown="code-block">
      <header className="markdown-code-header" data-streamdown="code-block-header">
        <span className="markdown-code-language">{languageLabel}</span>
        <div className="markdown-code-actions" data-streamdown="code-block-actions">
          <TooltipIconButton className="markdown-code-action" tooltip="下载代码" side="top" onClick={downloadCode}>
            <Download aria-hidden="true" />
          </TooltipIconButton>
          <TooltipIconButton
            className="markdown-code-action"
            tooltip={copied ? "已复制" : "复制代码"}
            side="top"
            onClick={() => void copyCode().catch(() => undefined)}
          >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </TooltipIconButton>
        </div>
      </header>
      <pre
        aria-label={`${languageLabel} 代码`}
        className="markdown-code-scroll"
        data-streamdown="code-block-body"
        style={{ "--markdown-code-line-number-width": lineNumberWidth } as CSSProperties}
        tabIndex={0}
      >
        <code className="markdown-code-content">
          {lines.map((line, lineIndex) => (
            <CodeLine
              key={`${lineIndex}:${line.map((token) => token.content).join("")}`}
              line={line}
              lineIndex={lineIndex}
            />
          ))}
        </code>
      </pre>
    </section>
  );
}

const HIGHLIGHT_BATCH_LINES = 10;
const HIGHLIGHT_SETTLE_MS = 250;

function useHighlightedCode(code: string, language: string): HighlightedCode | undefined {
  const [highlighted, setHighlighted] = useState<HighlightedCode | undefined>(undefined);

  useEffect(() => {
    let active = true;
    if (!language || !codeHighlighter.supportsLanguage(language as CodeLanguage)) {
      setHighlighted(undefined);
      return () => {
        active = false;
      };
    }

    const action = streamingHighlightAction(highlighted, code, language, HIGHLIGHT_BATCH_LINES);
    if (action.kind === "none") return;

    let cancelHighlight: () => void = () => undefined;
    const runHighlight = () => {
      if (!active) return;
      cancelHighlight = startHighlightRequest(
        codeHighlighter.highlight,
        { code, language: language as CodeLanguage, themes: SHIKI_THEMES },
        (result) => {
          if (active) setHighlighted(result ? { code, language, result } : undefined);
        },
      );
    };

    let timer: number | undefined;
    if (action.kind === "highlight") {
      runHighlight();
    } else {
      // 流式尾部：等待代码块停止增长后再高亮，保证完成的代码块不会残留纯文本尾部。
      timer = window.setTimeout(runHighlight, HIGHLIGHT_SETTLE_MS);
    }
    return () => {
      active = false;
      cancelHighlight();
      window.clearTimeout(timer);
    };
  }, [code, highlighted, language]);

  return highlighted;
}

type HighlightRequest = typeof codeHighlighter.highlight;

/** 保留加载中的旧高亮，并允许 effect cleanup 阻止过期异步结果回写。 */
export function startHighlightRequest(
  highlight: HighlightRequest,
  options: Parameters<HighlightRequest>[0],
  applyResult: (result: HighlightResult | undefined) => void,
): () => void {
  let active = true;
  const applyIfActive = (result: HighlightResult | undefined) => {
    if (active) applyResult(result);
  };
  try {
    const immediate = highlight(options, applyIfActive);
    if (immediate !== null) applyIfActive(immediate);
  } catch {
    applyIfActive(undefined);
  }
  return () => {
    active = false;
  };
}

/**
 * 流式高亮调度：流式追加的代码只按整行批量重新高亮，避免每个 delta 都重新 tokenize 整个代码块。
 * - "highlight": 立即高亮（首次渲染、内容被替换、或新增了足够的完整行）
 * - "settle": 等待流停止后补一次最终高亮（尾部不足一批时）
 * - "none": 已是最新高亮结果
 */
export function streamingHighlightAction(
  highlighted: HighlightedCode | undefined,
  code: string,
  language: string,
  batchLines: number,
): { kind: "none" } | { kind: "highlight" } | { kind: "settle" } {
  if (highlighted === undefined) return { kind: "highlight" };
  if (highlighted.code === code && highlighted.language === language) {
    return { kind: "none" };
  }
  if (highlighted.language !== language || !code.startsWith(highlighted.code)) {
    return { kind: "highlight" };
  }
  const completedTailLines = (code.slice(highlighted.code.length).match(/\n/g) ?? []).length;
  return completedTailLines >= batchLines ? { kind: "highlight" } : { kind: "settle" };
}

export function resolveHighlightedTokens(
  highlighted: HighlightedCode | undefined,
  code: string,
  language: string,
): HighlightResult["tokens"] | undefined {
  if (!highlighted || highlighted.language !== language) return undefined;
  if (highlighted.code === code) return highlighted.result.tokens;
  if (code.startsWith(highlighted.code)) {
    return mergeStreamingPrefix(highlighted.result.tokens, highlighted.code, code);
  }
  return undefined;
}

/** 高亮结果落后于当前流式代码时，保留已高亮的前缀行，尾部按纯文本行补齐。 */
function mergeStreamingPrefix(
  prefixTokens: HighlightResult["tokens"],
  prefixCode: string,
  code: string,
): HighlightResult["tokens"] {
  const tail = code.slice(prefixCode.length);
  if (tail === "") return prefixTokens;
  const lines = [...prefixTokens];
  const [firstTailLine, ...restTailLines] = tail.split("\n");
  if (firstTailLine !== "") {
    if (prefixCode.endsWith("\n")) {
      const lastLine = lines.at(-1);
      const replacement = [{ content: firstTailLine, offset: 0 }];
      if (lastLine !== undefined && lastLine.every((token) => token.content === "")) {
        lines[lines.length - 1] = replacement;
      } else {
        lines.push(replacement);
      }
    } else {
      const lastLine = lines.at(-1);
      if (lastLine !== undefined && lastLine.length > 0) {
        const lastToken = lastLine.at(-1)!;
        lines[lines.length - 1] = [
          ...lastLine,
          { content: firstTailLine, offset: lastToken.offset + lastToken.content.length },
        ];
      } else {
        lines.push([{ content: firstTailLine, offset: 0 }]);
      }
    }
  }
  for (const line of restTailLines) {
    lines.push([{ content: line, offset: 0 }]);
  }
  return lines;
}

function plainTokens(code: string): HighlightResult["tokens"] {
  return (code || " ").split("\n").map((line) => [{ content: line, offset: 0 }]);
}
