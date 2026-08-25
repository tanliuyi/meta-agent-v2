import { relative, resolve, sep } from "node:path";

/** 将 Project 相对路径解析到 cwd 内，拒绝目录穿越。 */
export function resolveProjectFilePath(cwd: string, path: string): string {
  const target = resolve(cwd, path);
  const child = relative(cwd, target);
  if (child === ".." || child.startsWith(`..${sep}`) || resolve(target) === resolve(cwd, "..")) {
    throw new Error("文件路径超出 Project cwd");
  }
  return target;
}

/** 将平台路径分隔符统一为 Workbench 使用的正斜杠。 */
export function normalizeProjectRelativePath(path: string): string {
  return path.split(sep).join("/");
}
