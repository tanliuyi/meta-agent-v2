import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";

/**
 * http/https/mailto 链接正则（对齐 VS Code WebLinkProvider 的常用子集：
 * 协议 + 域名 + 任意路径字符；路径字符集排除空白与引号避免吞掉相邻文本）。
 */
const URL_LINK_REGEX =
  /(?:https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b[-a-zA-Z0-9()@:%_+.~#?&//=]*|mailto:[^\s<>'"]+)/g;

/**
 * 宽松相对路径链接：./package.json、../src/foo.ts、src/foo/bar.ts 等。
 * 要求至少一个 / 或 \ 分隔符（或 ./-style 前缀），字符集排除空白与括号，
 * 因此尾随标点不会混入链接文本。URL 中 https:// 开头的部分因 "https/"
 * 后紧邻 "/" 无法命中，天然避免与 URL provider 重叠。
 */
const PATH_LINK_REGEX =
  /(?:\.{1,2}[/\\][A-Za-z0-9_@~.+-]+|(?:\.{1,2}[/\\])?[A-Za-z0-9_@~-][A-Za-z0-9_@~.+-]*[/\\][A-Za-z0-9_@~.+-]+(?:[/\\][A-Za-z0-9_@~.+-]+)*)/g;

/** 把一行的正则匹配转换为 xterm ILink 列表（range 为 1-based 闭区间）。 */
function matchLinks(text: string, regex: RegExp, line: number, activate: (text: string) => void): ILink[] {
  const links: ILink[] = [];
  regex.lastIndex = 0;
  for (let match = regex.exec(text); match; match = regex.exec(text)) {
    const start = match.index + 1;
    const end = start + match[0].length - 1;
    const linkText = match[0];
    links.push({
      range: { start: { x: start, y: line }, end: { x: end, y: line } },
      text: linkText,
      activate: () => activate(linkText),
    });
  }
  return links;
}

/** 读取 buffer 一行的文本（去掉行尾空白）。 */
function lineText(terminal: Terminal, bufferLineNumber: number): string | null {
  const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
  return line ? line.translateToString(true) : null;
}

/**
 * 注册 URL 与宽松路径两类链接 provider，点击时复用现有
 * window.desktop.links.open IPC 在应用内/系统打开。返回 dispose 函数。
 * 注意：xterm 按注册顺序让先注册的 provider 优先占用单元格，
 * 因此 URL provider 必须先注册，路径 provider 与 URL 重叠的部分会被移除。
 */
export function registerTerminalLinkProviders(terminal: Terminal, projectId: string): () => void {
  const urlProvider: ILinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      const text = lineText(terminal, bufferLineNumber);
      if (text === null) {
        callback(undefined);
        return;
      }
      callback(
        matchLinks(text, URL_LINK_REGEX, bufferLineNumber, (url) => {
          void window.desktop.links.open(projectId, url);
        }),
      );
    },
  };
  const pathProvider: ILinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      const text = lineText(terminal, bufferLineNumber);
      if (text === null) {
        callback(undefined);
        return;
      }
      callback(
        matchLinks(text, PATH_LINK_REGEX, bufferLineNumber, (path) => {
          void window.desktop.links.open(projectId, path);
        }),
      );
    },
  };
  const disposables = [terminal.registerLinkProvider(urlProvider), terminal.registerLinkProvider(pathProvider)];
  return () => {
    for (const disposable of disposables) disposable.dispose();
  };
}
