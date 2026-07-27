import { createWriteStream, renameSync, rmSync, type WriteStream } from "node:fs";
import type { IncomingMessage } from "node:http";
import { get } from "node:https";

const IDLE_TIMEOUT_MS = 30_000;
const TOTAL_TIMEOUT_MS = 10 * 60_000;
const MAX_REDIRECTS = 5;

export async function downloadRuntimeArchive(
  url: string,
  destination: string,
  description: string,
  onProgress: (percent: number) => void,
): Promise<void> {
  const temporaryPath = `${destination}.tmp-${process.pid}-${Date.now()}`;
  rmSync(temporaryPath, { force: true });
  try {
    await downloadRedirect(url, temporaryPath, description, onProgress, 0, Date.now() + TOTAL_TIMEOUT_MS);
    rmSync(destination, { force: true });
    renameSync(temporaryPath, destination);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function downloadRedirect(
  url: string,
  destination: string,
  description: string,
  onProgress: (percent: number) => void,
  redirects: number,
  deadline: number,
): Promise<void> {
  if (redirects > MAX_REDIRECTS) return Promise.reject(new Error(`${description} 下载重定向过多`));
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return Promise.reject(new Error(`${description} 下载超过 ${TOTAL_TIMEOUT_MS / 60_000} 分钟`));

  return new Promise((resolveDownload, rejectDownload) => {
    let settled = false;
    let response: IncomingMessage | undefined;
    let output: WriteStream | undefined;
    const totalTimeout = setTimeout(
      () => fail(new Error(`${description} 下载超过 ${TOTAL_TIMEOUT_MS / 60_000} 分钟`)),
      remainingMs,
    );
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimeout);
      resolveDownload();
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimeout);
      request.destroy();
      response?.destroy();
      if (output && !output.closed) {
        output.once("close", () => rejectDownload(error));
        output.destroy();
      } else {
        rejectDownload(error);
      }
    };
    const request = get(url, (nextResponse) => {
      response = nextResponse;
      response.setTimeout(IDLE_TIMEOUT_MS, () => fail(new Error(`${description} 下载连接超时`)));
      response.once("error", fail);
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        let nextUrl: string;
        try {
          nextUrl = new URL(response.headers.location, url).href;
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        response.resume();
        settled = true;
        clearTimeout(totalTimeout);
        void downloadRedirect(nextUrl, destination, description, onProgress, redirects + 1, deadline).then(
          resolveDownload,
          rejectDownload,
        );
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        fail(new Error(`${description} 下载失败: HTTP ${response.statusCode ?? "unknown"}`));
        return;
      }
      const total = Number(response.headers["content-length"] ?? 0);
      let received = 0;
      output = createWriteStream(destination, { flags: "w" });
      output.once("error", fail);
      response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (total > 0) onProgress(Math.min(50, Math.floor((received / total) * 50)));
      });
      response.pipe(output);
      output.once("finish", () => output?.close((error) => (error ? fail(error) : finish())));
    });
    request.setTimeout(IDLE_TIMEOUT_MS, () => fail(new Error(`${description} 下载连接超时`)));
    request.once("error", fail);
  });
}
