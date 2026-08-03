import type { HighlightResult } from "@streamdown/code";
import { useVirtualizer } from "@tanstack/react-virtual";
import ArrowDown from "lucide-react/dist/esm/icons/arrow-down.mjs";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import type { CSSProperties, KeyboardEvent, UIEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TextFile } from "../../../../../shared/contracts.ts";
import { resolveTokenStyle } from "../../assistant-ui/streamdown/streamdown-code-line.tsx";
import { findMatches, groupMatchesByLine, splitLineByMatches, splitTokensByMatches } from "./file-find.ts";
import { extractMinimapSegments, FileMinimap } from "./file-minimap.tsx";

/** 估算行高：--type-size-control 0.75rem × line-height 1.6 ≈ 19.2px。 */
const FILE_PREVIEW_LINE_HEIGHT = 20;
const FILE_PREVIEW_OVERSCAN = 20;

interface FilePreviewProps {
  file: TextFile;
  highlight: { file: TextFile; tokens: HighlightResult } | null;
  wrap: boolean;
  /** 大文件降级：跳过语法高亮并显示提示。 */
  degraded?: boolean;
  initialScrollTop?: number;
  onScrollChange(top: number): void;
}

/**
 * 只读代码预览。行窗口化渲染（对齐 VS Code ViewLines：只创建可见行 DOM），
 * wrap 模式下按实际行高动态测量；内置文件内查找（对齐 find widget）。
 */
export function FilePreview({ file, highlight, wrap, degraded, initialScrollTop, onScrollChange }: FilePreviewProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const onScrollChangeRef = useRef(onScrollChange);
  onScrollChangeRef.current = onScrollChange;
  const [currentLine, setCurrentLine] = useState<number | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findCase, setFindCase] = useState(false);
  const [activeFind, setActiveFind] = useState(0);

  const lines = useMemo(() => file.content.split("\n"), [file.content]);
  const tokens = highlight?.file === file ? highlight.tokens.tokens : null;

  // 缩略图用：每行的非空白 token 片段（行内字符范围 + 双主题颜色）。
  const minimapTokens = useMemo(() => (tokens ? extractMinimapSegments(tokens) : null), [tokens]);

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => preRef.current,
    estimateSize: () => FILE_PREVIEW_LINE_HEIGHT,
    overscan: FILE_PREVIEW_OVERSCAN,
    initialRect: { height: 600, width: 600 },
    measureElement: (element) => element.getBoundingClientRect().height,
  });

  // 恢复该文件上次的滚动位置（仅首次挂载；同文件内滚动位置由浏览器保持）。
  useEffect(() => {
    const pre = preRef.current;
    if (pre && initialScrollTop) pre.scrollTop = initialScrollTop;
    // 只在文件实例挂载时恢复一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 文件内查找（对齐 VS Code find widget）。
  const findMatchesList = useMemo(
    () => findMatches(file.content, findQuery, findCase),
    [file.content, findCase, findQuery],
  );
  const matchesByLine = useMemo(() => groupMatchesByLine(findMatchesList), [findMatchesList]);
  const activeMatch =
    findMatchesList.length > 0 ? findMatchesList[Math.min(activeFind, findMatchesList.length - 1)] : undefined;

  useEffect(() => {
    if (findOpen) {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    }
  }, [findOpen]);

  useEffect(() => {
    if (!activeMatch) return;
    virtualizer.scrollToIndex(activeMatch.line, { align: "center" });
  }, [activeMatch, virtualizer]);

  const goToFind = useCallback(
    (delta: 1 | -1) => {
      if (findMatchesList.length === 0) return;
      setActiveFind((current) => (current + delta + findMatchesList.length) % findMatchesList.length);
    },
    [findMatchesList.length],
  );

  const handlePreKeyDown = useCallback((event: KeyboardEvent<HTMLPreElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      setFindOpen(true);
      return;
    }
    if (event.key === "Escape") setFindOpen(false);
  }, []);

  const handleFindKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        goToFind(event.shiftKey ? -1 : 1);
      } else if (event.key === "Escape") {
        event.preventDefault();
        setFindOpen(false);
      }
    },
    [goToFind],
  );

  const handleScroll = useCallback((event: UIEvent<HTMLPreElement>) => {
    onScrollChangeRef.current(event.currentTarget.scrollTop);
  }, []);

  const handleMinimapNavigate = useCallback(
    (line: number) => {
      virtualizer.scrollToIndex(line, { align: "center" });
    },
    [virtualizer],
  );

  const virtualItems = virtualizer.getVirtualItems();
  const matchesCount = findMatchesList.length;

  return (
    <div className="file-preview-stack">
      {findOpen ? (
        <div className="file-find-bar" role="search">
          <Search size={13} aria-hidden="true" />
          <input
            ref={findInputRef}
            type="text"
            value={findQuery}
            onChange={(event) => {
              setFindQuery(event.target.value);
              setActiveFind(0);
            }}
            onKeyDown={handleFindKeyDown}
            placeholder="查找"
            aria-label="在文件中查找"
          />
          <button
            type="button"
            className="file-find-case"
            aria-label="区分大小写"
            aria-pressed={findCase}
            data-active={findCase || undefined}
            onClick={() => setFindCase((current) => !current)}
          >
            Aa
          </button>
          <span className="file-find-count" role="status">
            {findQuery
              ? matchesCount > 0
                ? `${Math.min(activeFind, matchesCount - 1) + 1} / ${matchesCount}`
                : "无结果"
              : ""}
          </span>
          <button
            type="button"
            className="file-find-nav"
            aria-label="上一个匹配"
            disabled={matchesCount === 0}
            onClick={() => goToFind(-1)}
          >
            <ArrowUp size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="file-find-nav"
            aria-label="下一个匹配"
            disabled={matchesCount === 0}
            onClick={() => goToFind(1)}
          >
            <ArrowDown size={12} aria-hidden="true" />
          </button>
          <button type="button" className="file-find-close" aria-label="关闭查找" onClick={() => setFindOpen(false)}>
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      <div className="file-preview-body">
        <pre
          ref={preRef}
          tabIndex={0}
          aria-label={`${file.path} 内容`}
          data-language={file.language}
          data-wrap={wrap || undefined}
          onKeyDown={handlePreKeyDown}
          onScroll={handleScroll}
          style={
            {
              "--file-preview-line-number-width": `${Math.max(2, String(lines.length).length)}ch`,
            } as CSSProperties
          }
        >
          {degraded ? (
            <div className="file-preview-note" role="note">
              文件较大，已禁用语法高亮
            </div>
          ) : null}
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              position: "relative",
              minWidth: "100%",
              minHeight: "100%",
            }}
          >
            {virtualItems.map((virtualRow) => {
              const lineIndex = virtualRow.index;
              const tokensOfLine = tokens?.[lineIndex] ?? null;
              const text = lines[lineIndex] ?? "";
              const lineMatches = matchesByLine.get(lineIndex) ?? [];
              const activeStart = activeMatch?.line === lineIndex ? activeMatch.start : undefined;
              return (
                <div
                  key={lineIndex}
                  data-index={lineIndex}
                  ref={virtualizer.measureElement}
                  className="file-preview-row"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <span
                    className="file-preview-line"
                    data-current={lineIndex === currentLine || undefined}
                    onClick={() => setCurrentLine((current) => (current === lineIndex ? null : lineIndex))}
                  >
                    <span className="file-preview-line-number" aria-hidden="true">
                      {lineIndex + 1}
                    </span>
                    <span className="file-preview-line-text">
                      {tokensOfLine
                        ? tokensOfLine.length === 0
                          ? " "
                          : splitTokensByMatches(tokensOfLine, lineMatches, activeStart).map(
                              (segment, segmentIndex) => (
                                <span
                                  className={segment.match ? "file-preview-match" : "file-preview-token"}
                                  data-active={segment.active || undefined}
                                  key={`${segmentIndex}:${segment.token.offset}`}
                                  style={segment.match ? undefined : resolveTokenStyle(segment.token)}
                                >
                                  {segment.text}
                                </span>
                              ),
                            )
                        : text === ""
                          ? " "
                          : splitLineByMatches(text, lineMatches, activeStart).map((segment, segmentIndex) =>
                              segment.match ? (
                                <span
                                  className="file-preview-match"
                                  data-active={segment.active || undefined}
                                  key={segmentIndex}
                                >
                                  {segment.text}
                                </span>
                              ) : (
                                <span key={segmentIndex}>{segment.text}</span>
                              ),
                            )}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </pre>
        <FileMinimap
          lines={lines}
          tokenSegments={minimapTokens}
          scrollElement={preRef}
          onNavigate={handleMinimapNavigate}
        />
      </div>
    </div>
  );
}
