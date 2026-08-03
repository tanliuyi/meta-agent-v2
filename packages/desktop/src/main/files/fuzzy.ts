/**
 * 文件名模糊匹配，参考 VS Code `src/vs/base/common/filters.ts` 的 fuzzyScore 思路。
 *
 * 子序列匹配（不区分大小写）。评分奖励：连续的匹配、更早的匹配位置、词首与首字母匹配；
 * 与 fuzzyScore 一致，第一个 pattern 字符总是取 word 中能匹配的最靠前位置。
 * 返回匹配分数（越高越好），不匹配返回 null。
 */

const CONTINUATION_BONUS = 30;
const POSITION_PENALTY = 2;
const WORD_START_BONUS = 20;
const FIRST_CHAR_BONUS = 15;

/**
 * 判断 pattern 是否为 word 的子序列并评分。
 * 空 pattern 视为不匹配（调用方应先过滤）。
 */
export function fuzzyMatch(pattern: string, word: string): number | null {
  const patternLow = pattern.toLowerCase();
  const wordLow = word.toLowerCase();
  const n = patternLow.length;
  const m = wordLow.length;
  if (n === 0 || n > m) return null;

  // 正向贪心：仅用于快速子序列判定。
  let cursor = 0;
  for (const char of patternLow) {
    const found = wordLow.indexOf(char, cursor);
    if (found === -1) return null;
    cursor = found + 1;
  }

  // DP 评分：从最后一个 pattern 字符往前。
  // next[pos] = pattern[i+1..] 中"以位置 pos 作为 pattern[i+1] 匹配位"的最大累计得分；-Infinity 表示不可行。
  // 转移时若右侧字符恰好相邻（p === pos + 1）则加连续性奖励，
  // 用后缀最大值把每层转移降到 O(m)，整体 O(n·m)。
  const NEG = Number.NEGATIVE_INFINITY;
  let next: number[] = new Array(m).fill(NEG);
  for (let i = n - 1; i >= 0; i--) {
    const current = new Array(m).fill(NEG);
    // suffixMax[p] = max(next[p'] for p' >= p)，用于非相邻转移的 O(1) 查询。
    const suffixMax = new Array<number>(m + 1).fill(NEG);
    for (let p = m - 1; p >= 0; p--) suffixMax[p] = Math.max(next[p], suffixMax[p + 1]);
    for (let pos = 0; pos < m; pos++) {
      if (wordLow[pos] !== patternLow[i]) continue;
      let local = -pos * POSITION_PENALTY;
      if (i === 0) {
        local += FIRST_CHAR_BONUS;
        if (pos === 0 || isWordStart(wordLow, pos)) local += WORD_START_BONUS;
      } else if (isWordStart(wordLow, pos)) {
        local += WORD_START_BONUS;
      }
      if (i === n - 1) {
        current[pos] = local;
        continue;
      }
      // 相邻位置 p === pos + 1 额外加连续奖励；其余用后缀最大值。
      const adjacent = next[pos + 1] === NEG ? NEG : next[pos + 1] + CONTINUATION_BONUS;
      const rest = pos + 2 <= m ? suffixMax[pos + 2] : NEG;
      const bestRight = Math.max(adjacent, rest);
      if (bestRight !== NEG) current[pos] = local + bestRight;
    }
    next = current;
  }

  // 首字符：取 word 中能匹配的最靠前位置（与 fuzzyScore 的 firstMatch 行为一致）。
  const firstPos = wordLow.indexOf(patternLow[0]);
  const score = firstPos === -1 ? NEG : next[firstPos];
  return score === NEG ? null : score;
}

function isWordStart(word: string, index: number): boolean {
  if (index === 0) return true;
  const previous = word[index - 1];
  return previous === "-" || previous === "_" || previous === "." || previous === " " || previous === "/";
}

/** 正向贪心得到的一组匹配字符下标（用于 UI 高亮）；无匹配返回空数组。 */
export function fuzzyMatchIndices(pattern: string, word: string): number[] {
  const patternLow = pattern.toLowerCase();
  const wordLow = word.toLowerCase();
  const indices: number[] = [];
  let cursor = 0;
  for (const char of patternLow) {
    const found = wordLow.indexOf(char, cursor);
    if (found === -1) return [];
    indices.push(found);
    cursor = found + 1;
  }
  return indices;
}
