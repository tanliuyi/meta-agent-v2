import type { HighlightResult } from "@streamdown/code";
import type { CSSProperties, KeyboardEvent, PointerEvent, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";

const VIEWPORT_MIN_PX = 8;
/** 对齐 VS Code MINIMAP_GUTTER_WIDTH：为 gutter 装饰预留的左侧空白。 */
const MINIMAP_GUTTER_WIDTH = 2;
const MINIMAP_CHAR_WIDTH = 1;
const MINIMAP_TAB_SIZE = 4;
const MINIMAP_FOREGROUND_ALPHA = 12 / 15;
const TOOLTIP_EDGE_PX = 10;
const WHITESPACE = /\s/;
/** 内容驱动宽度的上下限（CSS px）：窄布局下限约 56px，上限对齐 VS Code 默认 minimap 宽度。 */
const MINIMAP_WIDTH_MIN_PX = 56;
const MINIMAP_WIDTH_MAX_PX = 96;

// VS Code minimapPreBaked.ts 的 scale=1 字符表（MIT）：ASCII 32-126 + unknown，每字符 1x2 像素。
const MINIMAP_CHAR_DATA_HEX =
  "0000511D6300CF609C709645A78432005642574171487021003C451900274D35D762755E8B629C5BA856AF57BA649530C167D1512A272A3F6038604460398526BCA2A968DB6F8957C768BE5FBE2FB467CF5D8D5B795DC7625B5DFF50DE64C466DB2FC47CD860A65E9A2EB96CB54CE06DA763AB2EA26860524D3763536601005116008177A8705E53AB738E6A982F88BAA35B5F5B626D9C636B449B737E5B7B678598869A662F6B5B8542706C704C80736A607578685B70594A49715A4522E792";
const MINIMAP_CHAR_DATA = Uint8Array.from({ length: MINIMAP_CHAR_DATA_HEX.length / 2 }, (_, index) =>
  Number.parseInt(MINIMAP_CHAR_DATA_HEX.slice(index * 2, index * 2 + 2), 16),
);

/** 对齐 Monaco minimap：一行占 2px，长文件只绘制当前可见的 minimap 行窗。 */
export const MINIMAP_LINE_HEIGHT = 2;

export interface MinimapTokenSegment {
  start: number;
  end: number;
  light: string | null;
  dark: string | null;
}

/** 从 shiki tokens 提取非空白字符片段，并把文件全局偏移转换为行内偏移。 */
export function extractMinimapSegments(tokens: HighlightResult["tokens"]): MinimapTokenSegment[][] {
  return tokens.map((line) => {
    if (line.length === 0) return [];
    const lineStart = line[0].offset;
    const segments: MinimapTokenSegment[] = [];
    for (const token of line) {
      let runStart = -1;
      for (let index = 0; index <= token.content.length; index++) {
        const visible = index < token.content.length && !WHITESPACE.test(token.content[index] ?? "");
        if (visible && runStart === -1) runStart = index;
        if (!visible && runStart !== -1) {
          segments.push({
            start: token.offset - lineStart + runStart,
            end: token.offset - lineStart + index,
            light: token.color ?? token.htmlStyle?.color ?? null,
            dark: token.htmlStyle?.["--shiki-dark"] ?? null,
          });
          runStart = -1;
        }
      }
    }
    return segments;
  });
}

export interface MinimapLayout {
  contentOffset: number;
  scrollRange: number;
  sliderHeight: number;
  sliderTop: number;
  sliderTravel: number;
}

interface MinimapLayoutInput {
  clientHeight: number;
  height: number;
  lines: number;
  scrollHeight: number;
  scrollTop: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** 计算 minimap 内容窗口和视口滑块；两者与编辑器使用相同的归一化滚动范围。 */
export function calculateMinimapLayout({
  clientHeight,
  height,
  lines,
  scrollHeight,
  scrollTop,
}: MinimapLayoutInput): MinimapLayout {
  const safeHeight = Math.max(0, height);
  const scrollRange = Math.max(0, scrollHeight - clientHeight);
  const progress = scrollRange === 0 ? 0 : clamp(scrollTop / scrollRange, 0, 1);
  const contentHeight = Math.max(0, lines * MINIMAP_LINE_HEIGHT);
  const minimapContentHeight = Math.min(safeHeight, contentHeight);
  const naturalSliderHeight = scrollHeight > 0 ? (clientHeight / scrollHeight) * contentHeight : minimapContentHeight;
  const sliderHeight =
    scrollRange === 0
      ? minimapContentHeight
      : Math.min(minimapContentHeight, Math.max(VIEWPORT_MIN_PX, naturalSliderHeight));
  const sliderTravel = Math.max(0, minimapContentHeight - sliderHeight);
  return {
    contentOffset: progress * Math.max(0, contentHeight - safeHeight),
    scrollRange,
    sliderHeight,
    sliderTop: progress * sliderTravel,
    sliderTravel,
  };
}

/** 把 minimap 内部纵坐标映射到当前绘制窗口中的文件行。 */
export function getMinimapLineAt(y: number, height: number, lines: number, contentOffset: number): number {
  if (lines <= 1 || height <= 0) return 0;
  return clamp(Math.floor((clamp(y, 0, height) + contentOffset) / MINIMAP_LINE_HEIGHT), 0, lines - 1);
}

interface FileMinimapProps {
  /** 纯文本降级时也需实际文本行，以保留缩进和行宽。 */
  lines: readonly string[];
  tokenSegments: readonly (readonly MinimapTokenSegment[])[] | null;
  scrollElement: RefObject<HTMLPreElement | null>;
  onNavigate(line: number): void;
}

interface CanvasSurface {
  context: CanvasRenderingContext2D;
  height: number;
  width: number;
}

interface MinimapPalette {
  dark: boolean;
  fallback: string;
  viewport: string;
  viewportBorder: string;
}

interface DragState {
  pointerId: number;
  scrollPerPixel: number;
  scrollTop: number;
  startY: number;
}

function prepareCanvas(canvas: HTMLCanvasElement): CanvasSurface | null {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width === 0 || height === 0) return null;
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.max(1, Math.round(width * dpr));
  const pixelHeight = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { context, height, width };
}

function readPalette(): MinimapPalette {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  return {
    dark: root.dataset.theme === "dark",
    fallback: style.getPropertyValue("--file-minimap-fallback").trim() || "gray",
    viewport: style.getPropertyValue("--file-minimap-viewport").trim() || "gray",
    viewportBorder: style.getPropertyValue("--file-minimap-viewport-border").trim() || "gray",
  };
}

/** 对齐 VS Code getCharIndex（fontScale<=2 时表外字符按 96 取模回绕）。 */
export function getMinimapCharIndex(charCode: number): number {
  const index = charCode - 32;
  if (index >= 0 && index < 96) return index;
  return ((index % 96) + 96) % 96;
}

function isFullWidthCharacter(charCode: number): boolean {
  return (
    charCode >= 0x1100 &&
    (charCode <= 0x115f ||
      charCode === 0x2329 ||
      charCode === 0x232a ||
      (charCode >= 0x2e80 && charCode <= 0xa4cf) ||
      (charCode >= 0xac00 && charCode <= 0xd7a3) ||
      (charCode >= 0xf900 && charCode <= 0xfaff) ||
      (charCode >= 0xfe10 && charCode <= 0xfe19) ||
      (charCode >= 0xfe30 && charCode <= 0xfe6f) ||
      (charCode >= 0xff00 && charCode <= 0xff60) ||
      (charCode >= 0xffe0 && charCode <= 0xffe6))
  );
}

/**
 * 计算行内每个字符的 x 起始位置，对齐 VS Code InnerMinimap._renderLine：
 * 从 gutter 右侧开始，tab stop 按 MINIMAP_TAB_SIZE 展开，全角字符占 2 像素，
 * 超过 maxDx（width - 1px）后停止（长行裁剪）。
 */
export function getMinimapCharXOffsets(text: string, width: number): number[] {
  const offsets: number[] = [];
  const maxDx = width - MINIMAP_CHAR_WIDTH;
  let dx = MINIMAP_GUTTER_WIDTH;
  let tabsCharDelta = 0;
  for (let index = 0; index < text.length; index++) {
    if (dx > maxDx) break;
    offsets.push(dx);
    const charCode = text.charCodeAt(index);
    if (charCode === 9) {
      const spaces = MINIMAP_TAB_SIZE - ((index + tabsCharDelta) % MINIMAP_TAB_SIZE);
      tabsCharDelta += spaces - 1;
      dx += spaces * MINIMAP_CHAR_WIDTH;
    } else if (charCode === 32) {
      dx += MINIMAP_CHAR_WIDTH;
    } else {
      dx += (isFullWidthCharacter(charCode) ? 2 : 1) * MINIMAP_CHAR_WIDTH;
    }
  }
  return offsets;
}

/** 计算一行在 minimap 上的视觉列宽（含 gutter）：tab stop=4、全角=2，忽略行尾空白。 */
export function getMinimapLineColumns(text: string): number {
  let dx = MINIMAP_GUTTER_WIDTH;
  let tabsCharDelta = 0;
  let lineMax = MINIMAP_GUTTER_WIDTH;
  for (let index = 0; index < text.length; index++) {
    const charCode = text.charCodeAt(index);
    if (charCode === 9) {
      const spaces = MINIMAP_TAB_SIZE - ((index + tabsCharDelta) % MINIMAP_TAB_SIZE);
      tabsCharDelta += spaces - 1;
      dx += spaces * MINIMAP_CHAR_WIDTH;
    } else if (charCode === 32) {
      dx += MINIMAP_CHAR_WIDTH;
    } else {
      dx += (isFullWidthCharacter(charCode) ? 2 : 1) * MINIMAP_CHAR_WIDTH;
      lineMax = dx;
    }
  }
  return lineMax;
}

/**
 * VS Code 式内容驱动宽度：取全文最大视觉列宽并封顶（56-96px），作为 CSS 自定义目标宽度。
 * 容器只通过 flex shrink/max-width 限制，窄布局收缩到下限。
 */
export function getMinimapContentWidth(lines: readonly string[]): number {
  let maxColumns = MINIMAP_GUTTER_WIDTH;
  for (const text of lines) {
    const columns = getMinimapLineColumns(text);
    if (columns > maxColumns) maxColumns = columns;
  }
  return clamp(maxColumns, MINIMAP_WIDTH_MIN_PX, MINIMAP_WIDTH_MAX_PX);
}

/** 对齐 VS Code InnerMinimap._renderLine：1x2 预烘焙字符、tab stop 和全角字符宽度。 */
function drawMinimapLine(
  context: CanvasRenderingContext2D,
  text: string,
  segments: readonly MinimapTokenSegment[] | null,
  palette: MinimapPalette,
  y: number,
  width: number,
): void {
  // 与 getMinimapCharXOffsets 相同的单次扫描：直接维护 dx/tabsCharDelta，不创建偏移数组。
  const maxDx = width - MINIMAP_CHAR_WIDTH;
  let dx = MINIMAP_GUTTER_WIDTH;
  let tabsCharDelta = 0;
  let segmentIndex = 0;
  let previousColor = "";

  for (let index = 0; index < text.length; index++) {
    if (dx > maxDx) break;
    const charCode = text.charCodeAt(index);
    if (charCode === 9) {
      const spaces = MINIMAP_TAB_SIZE - ((index + tabsCharDelta) % MINIMAP_TAB_SIZE);
      tabsCharDelta += spaces - 1;
      dx += spaces * MINIMAP_CHAR_WIDTH;
      continue;
    }
    if (charCode === 32) {
      dx += MINIMAP_CHAR_WIDTH;
      continue;
    }

    while (segments && segmentIndex < segments.length && segments[segmentIndex].end <= index) segmentIndex++;
    const segment = segments?.[segmentIndex];
    const color =
      segment && segment.start <= index && index < segment.end
        ? ((palette.dark ? segment.dark : segment.light) ?? palette.fallback)
        : palette.fallback;
    if (color !== previousColor) {
      context.fillStyle = color;
      previousColor = color;
    }

    const sourceOffset = getMinimapCharIndex(charCode) * MINIMAP_LINE_HEIGHT;
    // 全角字符渲染 2 像素；第二个像素越界时跳过（对齐 _renderLine 的 dx > maxDx 检查）。
    const count = isFullWidthCharacter(charCode) ? 2 : 1;
    for (let pixel = 0; pixel < count && dx + pixel <= width - MINIMAP_CHAR_WIDTH; pixel++) {
      for (let row = 0; row < MINIMAP_LINE_HEIGHT; row++) {
        const alpha = (MINIMAP_CHAR_DATA[sourceOffset + row] / 255) * MINIMAP_FOREGROUND_ALPHA;
        if (alpha === 0) continue;
        context.globalAlpha = alpha;
        context.fillRect(dx + pixel, y + row, MINIMAP_CHAR_WIDTH, 1);
      }
    }
    dx += count * MINIMAP_CHAR_WIDTH;
  }
  context.globalAlpha = 1;
}

/**
 * VS Code 式代码缩略图：1x2 预烘焙字符像素保留缩进与行宽；背景和滑块分层绘制，
 * 滚动事件经 rAF 合并，指针提示使用 DOM ref 更新，不触发 React 高频重渲染。
 */
export function FileMinimap({ lines, tokenSegments, scrollElement, onNavigate }: FileMinimapProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const backgroundRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLCanvasElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const paletteRef = useRef<MinimapPalette | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const frameRef = useRef(0);
  const pointerYRef = useRef<number | null>(null);
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // VS Code 式内容驱动宽度：全文最大视觉列宽，封顶 56-96px；容器只靠 flex shrink 收缩。
  const targetWidth = useMemo(() => getMinimapContentWidth(lines), [lines]);

  const getLayout = useCallback(
    (height: number): MinimapLayout => {
      const scroll = scrollElement.current;
      return calculateMinimapLayout({
        clientHeight: scroll?.clientHeight ?? 0,
        height,
        lines: lines.length,
        scrollHeight: scroll?.scrollHeight ?? 0,
        scrollTop: scroll?.scrollTop ?? 0,
      });
    },
    [lines.length, scrollElement],
  );

  const drawBackground = useCallback(() => {
    const canvas = backgroundRef.current;
    if (!canvas) return;
    const surface = prepareCanvas(canvas);
    if (!surface) return;
    const { context, height, width } = surface;
    context.clearRect(0, 0, width, height);
    if (lines.length === 0) return;

    const palette = paletteRef.current ?? readPalette();
    paletteRef.current = palette;
    const { contentOffset } = getLayout(height);
    const firstLine = Math.max(0, Math.floor(contentOffset / MINIMAP_LINE_HEIGHT));
    const lastLine = Math.min(lines.length, Math.ceil((contentOffset + height) / MINIMAP_LINE_HEIGHT));

    for (let line = firstLine; line < lastLine; line++) {
      const y = Math.floor(line * MINIMAP_LINE_HEIGHT - contentOffset);
      drawMinimapLine(context, lines[line] ?? "", tokenSegments?.[line] ?? null, palette, y, width);
    }
  }, [getLayout, lines, tokenSegments]);

  const drawViewport = useCallback(() => {
    const canvas = viewportRef.current;
    const root = rootRef.current;
    if (!canvas || !root) return;
    const surface = prepareCanvas(canvas);
    if (!surface) return;
    const { context, height, width } = surface;
    context.clearRect(0, 0, width, height);
    const layout = getLayout(height);
    const progress = layout.scrollRange === 0 ? 0 : layout.sliderTop / Math.max(1, layout.sliderTravel);
    const currentLine = clamp(Math.round(progress * Math.max(0, lines.length - 1)) + 1, 1, Math.max(1, lines.length));
    root.setAttribute("aria-valuenow", String(currentLine));
    root.setAttribute("aria-valuetext", `第 ${currentLine} 行，共 ${Math.max(1, lines.length)} 行`);
    if (layout.scrollRange === 0) return;

    const palette = paletteRef.current ?? readPalette();
    paletteRef.current = palette;
    context.fillStyle = palette.viewport;
    context.fillRect(0, layout.sliderTop, width, layout.sliderHeight);
    context.strokeStyle = palette.viewportBorder;
    context.lineWidth = 1;
    context.strokeRect(0.5, layout.sliderTop + 0.5, Math.max(0, width - 1), Math.max(0, layout.sliderHeight - 1));
  }, [getLayout, lines.length]);

  const updateTooltip = useCallback(
    (clientY: number) => {
      const root = rootRef.current;
      const tooltip = tooltipRef.current;
      if (!root || !tooltip) return;
      const rect = root.getBoundingClientRect();
      if (rect.height === 0) return;
      const y = clamp(clientY - rect.top, 0, rect.height);
      const line = getMinimapLineAt(y, rect.height, lines.length, getLayout(rect.height).contentOffset);
      tooltip.textContent = `行 ${line + 1}`;
      tooltip.style.top = `${clamp(y, TOOLTIP_EDGE_PX, Math.max(TOOLTIP_EDGE_PX, rect.height - TOOLTIP_EDGE_PX))}px`;
      tooltip.hidden = false;
    },
    [getLayout, lines.length],
  );

  const scheduleDraw = useCallback(() => {
    if (frameRef.current !== 0) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      drawBackground();
      drawViewport();
      if (pointerYRef.current !== null) updateTooltip(pointerYRef.current);
    });
  }, [drawBackground, drawViewport, updateTooltip]);

  useEffect(() => {
    paletteRef.current = readPalette();
    // Electron 在窗口失焦或面板刚切换时可能暂停 rAF；首帧必须同步绘制，避免永久空白。
    drawBackground();
    drawViewport();
  }, [drawBackground, drawViewport]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(scheduleDraw);
    observer.observe(root);
    return () => observer.disconnect();
  }, [scheduleDraw]);

  useEffect(() => {
    const scroll = scrollElement.current;
    if (!scroll) return;
    scroll.addEventListener("scroll", scheduleDraw, { passive: true });
    return () => scroll.removeEventListener("scroll", scheduleDraw);
  }, [scheduleDraw, scrollElement]);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      paletteRef.current = readPalette();
      scheduleDraw();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    return () => observer.disconnect();
  }, [scheduleDraw]);

  useEffect(() => {
    return () => {
      if (frameRef.current !== 0) cancelAnimationFrame(frameRef.current);
      if (tooltipTimerRef.current !== null) clearTimeout(tooltipTimerRef.current);
    };
  }, []);

  const hideTooltip = useCallback(() => {
    pointerYRef.current = null;
    if (tooltipTimerRef.current !== null) clearTimeout(tooltipTimerRef.current);
    const tooltip = tooltipRef.current;
    if (tooltip) tooltip.hidden = true;
  }, []);

  const showTooltip = useCallback(
    (clientY: number) => {
      pointerYRef.current = clientY;
      updateTooltip(clientY);
      if (tooltipTimerRef.current !== null) clearTimeout(tooltipTimerRef.current);
      tooltipTimerRef.current = setTimeout(hideTooltip, 1000);
    },
    [hideTooltip, updateTooltip],
  );

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const root = event.currentTarget;
      const rect = root.getBoundingClientRect();
      if (rect.height === 0) return;
      const y = clamp(event.clientY - rect.top, 0, rect.height);
      const layout = getLayout(rect.height);
      const onSlider = y >= layout.sliderTop && y <= layout.sliderTop + layout.sliderHeight;

      event.preventDefault();
      if (!onSlider && event.pointerType === "mouse") {
        onNavigateRef.current(getMinimapLineAt(y, rect.height, lines.length, layout.contentOffset));
        return;
      }

      const scroll = scrollElement.current;
      if (!scroll || layout.sliderTravel === 0) return;
      if (!onSlider) {
        scroll.scrollTop = clamp((y - layout.sliderHeight / 2) / layout.sliderTravel, 0, 1) * layout.scrollRange;
      }
      dragRef.current = {
        pointerId: event.pointerId,
        scrollPerPixel: layout.scrollRange / layout.sliderTravel,
        scrollTop: scroll.scrollTop,
        startY: event.clientY,
      };
      root.dataset.dragging = "";
      root.setPointerCapture(event.pointerId);
      hideTooltip();
    },
    [getLayout, hideTooltip, lines.length, scrollElement],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag?.pointerId === event.pointerId) {
        const scroll = scrollElement.current;
        if (scroll) scroll.scrollTop = drag.scrollTop + (event.clientY - drag.startY) * drag.scrollPerPixel;
        return;
      }
      showTooltip(event.clientY);
    },
    [scrollElement, showTooltip],
  );

  const finishDragging = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    delete event.currentTarget.dataset.dragging;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const root = rootRef.current;
      const scroll = scrollElement.current;
      if (!root || !scroll) return;
      const layout = getLayout(root.clientHeight);
      const currentLine = getMinimapLineAt(
        root.clientHeight / 2,
        root.clientHeight,
        lines.length,
        layout.contentOffset,
      );
      const pageLines = Math.max(
        1,
        Math.floor((scroll.clientHeight / Math.max(1, scroll.scrollHeight)) * lines.length),
      );
      let target: number;
      switch (event.key) {
        case "ArrowUp":
          target = currentLine - 1;
          break;
        case "ArrowDown":
          target = currentLine + 1;
          break;
        case "PageUp":
          target = currentLine - pageLines;
          break;
        case "PageDown":
          target = currentLine + pageLines;
          break;
        case "Home":
          target = 0;
          break;
        case "End":
          target = lines.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      onNavigateRef.current(clamp(target, 0, Math.max(0, lines.length - 1)));
    },
    [getLayout, lines.length, scrollElement],
  );

  return (
    <div
      ref={rootRef}
      className="file-minimap"
      style={{ "--file-minimap-target-width": `${targetWidth}px` } as CSSProperties}
      role="slider"
      tabIndex={0}
      aria-label="代码缩略图"
      aria-orientation="vertical"
      aria-valuemin={1}
      aria-valuemax={Math.max(1, lines.length)}
      aria-valuenow={1}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerLeave={hideTooltip}
      onPointerUp={finishDragging}
      onPointerCancel={finishDragging}
    >
      <canvas ref={backgroundRef} className="file-minimap-bg" aria-hidden="true" />
      <canvas ref={viewportRef} className="file-minimap-viewport" aria-hidden="true" />
      <div ref={tooltipRef} className="file-minimap-hover" role="tooltip" hidden />
    </div>
  );
}
