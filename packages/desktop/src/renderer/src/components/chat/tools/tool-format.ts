/** 编辑工具中可结构化展示的单次文本替换。 */
export interface ToolEdit {
  oldText: string;
  newText: string;
}

/** 逐行 diff 的行类型与单行结构。 */
export type DiffLineType = "context" | "remove" | "add" | "meta";

export interface DiffLine {
  type: DiffLineType;
  text: string;
  lineNumber?: string;
}

export interface ParsedToolResult {
  text: string;
  details?: Readonly<Record<string, unknown>>;
  images?: readonly ParsedToolImage[];
}

export interface ParsedToolImage {
  data: string;
  mimeType: string;
}

interface SplitText {
  lines: string[];
  endsWithNewline: boolean;
}

/** 将字符串拆分为行，并独立保留 EOF 换行状态。 */
function splitLines(value: string): SplitText {
  if (value === "") return { lines: [], endsWithNewline: false };
  const endsWithNewline = value.endsWith("\n");
  const lines = value.split("\n");
  if (endsWithNewline) lines.pop();
  return { lines, endsWithNewline };
}

/** 按候选键顺序读取第一个字符串参数。 */
export function readToolStringArgument(args: Readonly<Record<string, unknown>>, ...names: string[]): string {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string") return value;
  }
  return "";
}

/** 将 Pi toolResult 协议解包为 TUI renderer 使用的文本与 details。 */
export function parseToolResult(value: unknown): ParsedToolResult | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || !("content" in value) || !Array.isArray(value.content)) {
    return { text: formatToolValue(value) };
  }

  const text = value.content
    .flatMap((part) => {
      if (!part || typeof part !== "object" || !("type" in part)) return [];
      return part.type === "text" && "text" in part && typeof part.text === "string" ? [stripAnsi(part.text)] : [];
    })
    .join("\n")
    .replace(/\r/g, "");
  const images = value.content.flatMap((part): ParsedToolImage[] => {
    if (!part || typeof part !== "object" || !("type" in part) || part.type !== "image") return [];
    if (!("data" in part) || typeof part.data !== "string") return [];
    if (!("mimeType" in part) || typeof part.mimeType !== "string") return [];
    return [{ data: part.data, mimeType: part.mimeType }];
  });
  const details = "details" in value && isRecord(value.details) ? value.details : undefined;
  return { text, details, ...(images.length > 0 ? { images } : {}) };
}

/** 解析 TUI edit renderer 生成的带行号 diff。 */
export function parseRenderedToolDiff(value: unknown): DiffLine[] | undefined {
  const diff = parseToolResult(value)?.details?.diff;
  if (typeof diff !== "string") return undefined;
  return diff.split("\n").map((line): DiffLine => {
    const match = line.match(/^([+\- ])(\s*\d*)\s(.*)$/);
    if (!match) return { type: "meta", text: line };
    const type = match[1] === "+" ? "add" : match[1] === "-" ? "remove" : "context";
    return { type, lineNumber: match[2].trim(), text: match[3] };
  });
}

/** 从未知输入中提取结构有效的编辑记录。 */
export function parseToolEdits(value: unknown): ToolEdit[] {
  if (typeof value === "string") {
    try {
      return parseToolEdits(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const edits: ToolEdit[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const edit = item as Record<string, unknown>;
    if (typeof edit.oldText === "string" && typeof edit.newText === "string") {
      edits.push({ oldText: edit.oldText, newText: edit.newText });
    }
  }
  return edits;
}

/** 解析当前 edits 数组及历史单次替换参数。 */
export function parseToolEditArguments(args: Readonly<Record<string, unknown>>): ToolEdit[] {
  const edits = parseToolEdits(args.edits);
  if (edits.length > 0) return edits;
  return typeof args.oldText === "string" && typeof args.newText === "string"
    ? [{ oldText: args.oldText, newText: args.newText }]
    : [];
}

/** DP 表内存上限，超过则退化为整体增删。 */
const DIFF_CELL_LIMIT = 400_000;
const DIFF_LINE_LIMIT = 500;

function limitDiffLines(lines: DiffLine[]): DiffLine[] {
  if (lines.length <= DIFF_LINE_LIMIT) return lines;
  const headCount = Math.floor((DIFF_LINE_LIMIT - 1) / 2);
  const tailCount = DIFF_LINE_LIMIT - headCount - 1;
  return [
    ...lines.slice(0, headCount),
    { type: "meta", text: `… 已省略 ${lines.length - headCount - tailCount} 行 …` },
    ...lines.slice(-tailCount),
  ];
}

function appendEofMarker(lines: DiffLine[], oldValue: SplitText, newValue: SplitText): DiffLine[] {
  if (oldValue.endsWithNewline === newValue.endsWithNewline) return lines;
  lines.push({
    type: "meta",
    text: oldValue.endsWithNewline ? "新内容末尾无换行" : "旧内容末尾无换行",
  });
  return lines;
}

/** 基于最长公共子序列计算逐行 diff，输出有界的统一行变更。 */
export function diffToolEdit(oldText: string, newText: string): DiffLine[] {
  const oldValue = splitLines(oldText);
  const newValue = splitLines(newText);
  const a = oldValue.lines;
  const b = newValue.lines;
  if (oldText === newText) return limitDiffLines(a.map((text): DiffLine => ({ type: "context", text })));
  if (a.length === 0 && b.length === 0) return appendEofMarker([], oldValue, newValue);
  if (a.length === 0) {
    return limitDiffLines(
      appendEofMarker(
        b.map((text): DiffLine => ({ type: "add", text })),
        oldValue,
        newValue,
      ),
    );
  }
  if (b.length === 0) {
    return limitDiffLines(
      appendEofMarker(
        a.map((text): DiffLine => ({ type: "remove", text })),
        oldValue,
        newValue,
      ),
    );
  }
  if (a.length * b.length > DIFF_CELL_LIMIT) {
    return limitDiffLines(
      appendEofMarker(
        [
          ...a.map((text): DiffLine => ({ type: "remove", text })),
          ...b.map((text): DiffLine => ({ type: "add", text })),
        ],
        oldValue,
        newValue,
      ),
    );
  }

  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      lines.push({ type: "context", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ type: "remove", text: a[i] });
      i++;
    } else {
      lines.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < m) lines.push({ type: "remove", text: a[i++] });
  while (j < n) lines.push({ type: "add", text: b[j++] });
  return limitDiffLines(appendEofMarker(lines, oldValue, newValue));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

/** 将字符串或 JSON 值格式化为工具面板可直接展示的文本。 */
export function formatToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}
