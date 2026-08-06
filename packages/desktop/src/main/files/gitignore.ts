import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** 单条解析后的 .gitignore 规则。 */
export interface GitignoreRule {
  /** 否定规则（! 前缀），命中时取消忽略。 */
  readonly negated: boolean;
  /** 仅匹配目录（结尾 /）。 */
  readonly directoryOnly: boolean;
  /** 锚定规则：含非尾部 '/',相对 .gitignore 所在目录匹配；否则按 basename 任意层级匹配。 */
  readonly anchored: boolean;
  /** 编译后的正则（anchored 时为相对路径匹配，否则为 basename 匹配）。 */
  readonly regex: RegExp;
}

/** 一层目录的 .gitignore 规则。 */
export interface GitignoreLayer {
  /** 该 .gitignore 所在目录相对项目 cwd 的深度（cwd 自身为 0）。 */
  readonly depth: number;
  /** 按行序解析的规则。 */
  readonly rules: readonly GitignoreRule[];
}

/**
 * 解析 .gitignore 文本为规则列表（保持行序，后出现的规则优先）。
 * 支持注释、! 否定、结尾 / 目录限定、/ 锚定、*、**、?、[...] 与 \ 转义。
 */
export function parseGitignore(content: string): readonly GitignoreRule[] {
  const rules: GitignoreRule[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    let pattern = rawLine;
    const escapedLeadingMarker = pattern.startsWith("\\#") || pattern.startsWith("\\!");
    if (escapedLeadingMarker) pattern = pattern.slice(1);
    if (!escapedLeadingMarker && pattern.startsWith("#")) continue;
    let negated = false;
    if (!escapedLeadingMarker && pattern.startsWith("!")) {
      negated = true;
      pattern = pattern.slice(1);
    }
    if (pattern.endsWith("\\ ")) {
      pattern = `${pattern.slice(0, -1)} `;
    } else {
      pattern = pattern.trimEnd();
    }
    if (pattern === "") continue;
    let directoryOnly = false;
    if (pattern.endsWith("/")) {
      directoryOnly = true;
      pattern = pattern.slice(0, -1);
    }
    if (pattern === "") continue;
    const anchored = pattern.includes("/");
    if (pattern.startsWith("/")) pattern = pattern.slice(1);
    if (pattern === "") continue;
    rules.push({ negated, directoryOnly, anchored, regex: globToRegExp(pattern) });
  }
  return rules;
}

/** 读取目录的 .gitignore 层；目录中不存在 .gitignore 时返回 null。 */
export async function readGitignoreLayer(dir: string, depth: number): Promise<GitignoreLayer | null> {
  let content: string;
  try {
    content = await readFile(join(dir, ".gitignore"), "utf8");
  } catch {
    return null;
  }
  return { depth, rules: parseGitignore(content) };
}

/** 收集从 cwd 到 target（含）路径链上每一级的 .gitignore 层，按深度升序。 */
export async function collectGitignoreLayers(cwd: string, target: string): Promise<GitignoreLayer[]> {
  const segments = relative(cwd, target) === "" ? [] : relative(cwd, target).split(sep);
  const layers: GitignoreLayer[] = [];
  let dir = cwd;
  for (let depth = 0; depth <= segments.length; depth++) {
    const layer = await readGitignoreLayer(dir, depth);
    if (layer) layers.push(layer);
    if (depth < segments.length) dir = join(dir, segments[depth]!);
  }
  return layers;
}

/**
 * 判断相对路径（/ 分隔）是否被规则忽略。
 * 遵循 git 语义：更深的 .gitignore 与后出现的行优先；
 * 祖先目录被忽略后，其下内容不可被否定规则重新包含。
 */
export function isPathIgnored(relativePath: string, isDirectory: boolean, layers: readonly GitignoreLayer[]): boolean {
  const segments = relativePath.split("/");
  for (let length = segments.length; length >= 1; length--) {
    const prefixIsDirectory = length < segments.length || isDirectory;
    const basename = segments[length - 1]!;
    let matched: GitignoreRule | undefined;
    for (const layer of layers) {
      if (layer.depth >= length) break;
      for (const rule of layer.rules) {
        if (rule.directoryOnly && !prefixIsDirectory) continue;
        const target = rule.anchored ? segments.slice(layer.depth, length).join("/") : basename;
        if (rule.regex.test(target)) matched = rule;
      }
    }
    if (matched?.negated) continue;
    if (matched) return true;
  }
  return false;
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:[^/]+/)*";
          index += 3;
        } else if (index + 2 >= pattern.length) {
          // 尾部 **：foo/** 忽略 foo 下全部内容（不含 foo 自身）
          source += ".*";
          index += 2;
        } else {
          source += "[^/]*";
          index += 2;
        }
      } else {
        source += "[^/]*";
        index += 1;
      }
    } else if (char === "?") {
      source += "[^/]";
      index += 1;
    } else if (char === "[") {
      let end = index + 1;
      let negated = false;
      if (pattern[end] === "!" || pattern[end] === "^") {
        negated = true;
        end++;
      }
      let body = "";
      let closed = false;
      while (end < pattern.length) {
        const next = pattern[end]!;
        if (next === "]" && body.length > 0) {
          closed = true;
          break;
        }
        if (next === "\\" && end + 1 < pattern.length) {
          body += escapeRegExp(pattern[end + 1]!);
          end += 2;
          continue;
        }
        body += next;
        end++;
      }
      if (closed) {
        source += `[${negated ? "^" : ""}${body}]`;
        index = end + 1;
      } else {
        source += "\\[";
        index += 1;
      }
    } else if (char === "\\") {
      if (index + 1 < pattern.length) {
        source += escapeRegExp(pattern[index + 1]!);
        index += 2;
      } else {
        source += "\\\\";
        index += 1;
      }
    } else {
      source += escapeRegExp(char);
      index += 1;
    }
  }
  source += "$";
  return new RegExp(source);
}

const REGEXP_SPECIALS = /[.+^${}()|[\]\\]/g;

function escapeRegExp(value: string): string {
  return value.replace(REGEXP_SPECIALS, "\\$&");
}
