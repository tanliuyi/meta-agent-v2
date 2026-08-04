import type { ISearchOptions } from "@xterm/addon-search";
import { SearchAddon } from "@xterm/addon-search";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { useEffect, useMemo, useRef, useState } from "react";

interface TerminalSearchBarProps {
  addon: SearchAddon;
  onClose(): void;
}

interface SearchResults {
  /** 当前匹配下标（0-based）；超过 highlightLimit 时 xterm 报 -1。 */
  index: number;
  count: number;
}

/** 把 --terminal-* 的 HSL 通道 token（如 "220 15% 26%"）转换为 #RRGGBB。 */
function hslChannelsToHex(channels: string): string | null {
  const match = channels.match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/);
  if (!match) return null;
  const hue = Number(match[1]);
  const saturation = Number(match[2]) / 100;
  const lightness = Number(match[3]) / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const secondary = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const offset = lightness - chroma / 2;
  let red = 0;
  let green = 0;
  let blue = 0;
  if (hue < 60) {
    red = chroma;
    green = secondary;
  } else if (hue < 120) {
    red = secondary;
    green = chroma;
  } else if (hue < 180) {
    green = chroma;
    blue = secondary;
  } else if (hue < 240) {
    green = secondary;
    blue = chroma;
  } else if (hue < 300) {
    red = secondary;
    blue = chroma;
  } else {
    red = chroma;
    blue = secondary;
  }
  const channel = (value: number) =>
    Math.round((value + offset) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

/** 从当前主题读取搜索高亮色；token 缺失/格式异常时返回 undefined，由 xterm 使用默认装饰色。 */
function readTerminalColor(property: string): string | undefined {
  const channels = getComputedStyle(document.documentElement).getPropertyValue(property).trim();
  return hslChannelsToHex(channels) ?? undefined;
}

/**
 * 终端内搜索浮层条：输入即搜、上一条/下一条、n/m 计数、Esc 或按钮关闭。
 * 关闭时清除 xterm 搜索装饰（selection 与高亮）。
 */
export function TerminalSearchBar({ addon, onClose }: TerminalSearchBarProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults>({ index: -1, count: 0 });
  const input = useRef<HTMLInputElement>(null);

  // 装饰色必须为 #RRGGBB，从 --terminal-* token 读取以跟随主题（与徽标/容器同源）；
  // token 缺失时留 undefined 走 xterm 默认装饰色，不引入组件色字面量。
  // matchOverviewRuler/activeMatchColorOverviewRuler 在类型上必填，但 desktop 未启用
  // overview ruler（Terminal options 未配置），给空串即可，渲染层不会使用。
  const decorationColors = useMemo(
    () => ({
      matchBackground: readTerminalColor("--terminal-selection"),
      matchBorder: readTerminalColor("--terminal-border"),
      matchOverviewRuler: readTerminalColor("--terminal-muted") ?? "",
      activeMatchBackground: readTerminalColor("--terminal-cursor"),
      activeMatchBorder: readTerminalColor("--terminal-cursor"),
      activeMatchColorOverviewRuler: readTerminalColor("--terminal-foreground") ?? "",
    }),
    [],
  );
  const searchOptions = useMemo<ISearchOptions>(
    () => ({ decorations: decorationColors, incremental: true }),
    [decorationColors],
  );

  useEffect(() => {
    input.current?.focus();
    const resultsChange = addon.onDidChangeResults((event) => {
      setResults({ index: event.resultIndex, count: event.resultCount });
    });
    return () => resultsChange.dispose();
  }, [addon]);

  // 卸载（关闭搜索条）时清理高亮与搜索选择。
  useEffect(() => () => addon.clearDecorations(), [addon]);

  const run = (term: string, forward: boolean) => {
    if (!term) {
      addon.clearDecorations();
      setResults({ index: -1, count: 0 });
      return;
    }
    if (forward) addon.findNext(term, searchOptions);
    else addon.findPrevious(term, searchOptions);
  };

  const label =
    results.count > 0 && results.index >= 0 ? `${results.index + 1}/${results.count}` : `-/${results.count}`;

  return (
    <div className="terminal-search-bar" role="search">
      <input
        ref={input}
        className="terminal-search-input"
        placeholder="搜索终端"
        value={query}
        spellCheck={false}
        onChange={(event) => {
          const value = event.target.value;
          setQuery(value);
          run(value, true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          else if (event.key === "Enter") run(query, !event.shiftKey);
        }}
      />
      <span className="terminal-search-count">{label}</span>
      <button
        type="button"
        className="terminal-search-button"
        title="上一个匹配"
        aria-label="上一个匹配"
        disabled={!query}
        onClick={() => run(query, false)}
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        className="terminal-search-button"
        title="下一个匹配"
        aria-label="下一个匹配"
        disabled={!query}
        onClick={() => run(query, true)}
      >
        <ChevronDown size={14} />
      </button>
      <button type="button" className="terminal-search-button" title="关闭搜索" aria-label="关闭搜索" onClick={onClose}>
        <X size={14} />
      </button>
    </div>
  );
}
