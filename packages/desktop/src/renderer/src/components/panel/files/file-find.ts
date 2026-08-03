/** 文件内查找的纯函数：匹配定位与行内区间拆分（对齐 VS Code find widget 的单行匹配语义）。 */

export interface FileFindMatch {
  line: number;
  /** 行内起始偏移（含）。 */
  start: number;
  /** 行内结束偏移（不含）。 */
  end: number;
}

/** 行内匹配区间与普通文本的拆分片段。 */
export interface FindSegment {
  text: string;
  match: boolean;
  active: boolean;
}

/** 按行计算全部匹配（不跨行）。空查询返回空数组。 */
export function findMatches(content: string, query: string, caseSensitive = false): FileFindMatch[] {
  if (!query) return [];
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: FileFindMatch[] = [];
  let line = 0;
  for (const lineText of content.split("\n")) {
    const searchText = caseSensitive ? lineText : lineText.toLowerCase();
    let position = 0;
    while (true) {
      const found = searchText.indexOf(needle, position);
      if (found === -1) break;
      matches.push({ line, start: found, end: found + query.length });
      position = found + query.length;
    }
    line += 1;
  }
  return matches;
}

/** 按行号分组，行渲染时 O(1) 取用。 */
export function groupMatchesByLine(matches: readonly FileFindMatch[]): ReadonlyMap<number, readonly FileFindMatch[]> {
  const grouped = new Map<number, FileFindMatch[]>();
  for (const match of matches) {
    const list = grouped.get(match.line);
    if (list) list.push(match);
    else grouped.set(match.line, [match]);
  }
  return grouped;
}

/** 把单行文本按匹配区间拆成片段；activeStart 为该行中“当前匹配”的起始偏移。 */
export function splitLineByMatches(
  text: string,
  matches: readonly FileFindMatch[],
  activeStart: number | undefined,
): FindSegment[] {
  if (matches.length === 0) return [{ text, match: false, active: false }];
  const segments: FindSegment[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) segments.push({ text: text.slice(cursor, match.start), match: false, active: false });
    segments.push({
      text: text.slice(match.start, match.end),
      match: true,
      active: match.start === activeStart,
    });
    cursor = match.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false, active: false });
  return segments;
}

/** token 行：把每个 token 按匹配区间再拆分，保留 token 的着色信息。 */
export interface FindTokenSegment<T extends { content: string; offset: number }> extends FindSegment {
  /** 拆分来源的原始 token（着色用）。 */
  token: T;
}

export function splitTokensByMatches<T extends { content: string; offset: number }>(
  tokens: readonly T[],
  matches: readonly FileFindMatch[],
  activeStart: number | undefined,
): FindTokenSegment<T>[] {
  if (matches.length === 0) {
    return tokens.map((token) => ({
      text: token.content,
      match: false,
      active: false,
      token,
    }));
  }
  const segments: FindTokenSegment<T>[] = [];
  for (const token of tokens) {
    const tokenStart = token.offset;
    const tokenEnd = token.offset + token.content.length;
    // 与当前行匹配区间求交集（matches 已经按行过滤）。
    let cursor = tokenStart;
    for (const match of matches) {
      if (match.end <= tokenStart || match.start >= tokenEnd) continue;
      if (match.start > cursor) {
        segments.push({
          text: token.content.slice(cursor - tokenStart, match.start - tokenStart),
          match: false,
          active: false,
          token,
        });
      }
      segments.push({
        text: token.content.slice(match.start - tokenStart, match.end - tokenStart),
        match: true,
        active: match.start === activeStart,
        token,
      });
      cursor = match.end;
    }
    if (cursor < tokenEnd) {
      segments.push({
        text: token.content.slice(cursor - tokenStart),
        match: false,
        active: false,
        token,
      });
    }
  }
  return segments;
}
