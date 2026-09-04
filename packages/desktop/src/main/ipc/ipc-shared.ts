import { shell } from "electron";

/** 使用系统默认程序打开路径，并将 Electron 错误转换为异常。 */
export async function openPath(path: string): Promise<void> {
  const error = await shell.openPath(path);
  if (error) throw new Error(error);
}
