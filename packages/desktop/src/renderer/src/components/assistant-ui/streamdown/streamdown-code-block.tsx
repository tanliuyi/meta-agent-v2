import { TooltipIconButton } from "@renderer/components/assistant-ui/tooltip-icon-button";
import { code as codeHighlighter, type HighlightResult } from "@streamdown/code";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import Download from "lucide-react/dist/esm/icons/download.mjs";
import { type CSSProperties, useEffect, useRef, useState } from "react";
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
            <span className="markdown-code-line" key={`${lineIndex}:${line.map((token) => token.content).join("")}`}>
              <span className="markdown-code-line-number" aria-hidden="true">
                {lineIndex + 1}
              </span>
              <span className="markdown-code-line-text">
                {line.length === 0
                  ? " "
                  : line.map((token, tokenIndex) => (
                      <span
                        className="markdown-code-token"
                        key={`${tokenIndex}:${token.offset}`}
                        style={tokenStyle(token)}
                        {...token.htmlAttrs}
                      >
                        {token.content}
                      </span>
                    ))}
              </span>
            </span>
          ))}
        </code>
      </pre>
    </section>
  );
}

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

    const applyResult = (result: HighlightResult | undefined) => {
      if (active) setHighlighted(result ? { code, language, result } : undefined);
    };

    try {
      const immediate = codeHighlighter.highlight(
        { code, language: language as CodeLanguage, themes: SHIKI_THEMES },
        applyResult,
      );
      applyResult(immediate ?? undefined);
    } catch {
      applyResult(undefined);
    }

    return () => {
      active = false;
    };
  }, [code, language]);

  return highlighted;
}

export function resolveHighlightedTokens(
  highlighted: HighlightedCode | undefined,
  code: string,
  language: string,
): HighlightResult["tokens"] | undefined {
  return highlighted?.code === code && highlighted.language === language ? highlighted.result.tokens : undefined;
}

function plainTokens(code: string): HighlightResult["tokens"] {
  return (code || " ").split("\n").map((line) => [{ content: line, offset: 0 }]);
}

function tokenStyle(token: HighlightResult["tokens"][number][number]): CSSProperties {
  const style: Record<string, string> = { ...token.htmlStyle };
  if (token.color) style["--markdown-code-token-color"] = token.color;
  if (token.bgColor) style["--markdown-code-token-background"] = token.bgColor;
  return style as CSSProperties;
}
