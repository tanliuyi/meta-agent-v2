import type { RuntimeCompatibility } from "../../shared/sidecar-contracts.ts";

export function appendMarketplaceRuntimeQuery(url: URL, runtime: RuntimeCompatibility): void {
  for (const [key, value] of Object.entries(runtime)) {
    if (value) url.searchParams.set(key, value);
  }
}

export async function readBoundedJsonResponse(
  response: Response,
  maxBytes: number,
  description: string,
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`${description} is too large`);
  }
  if (!response.body) throw new Error(`${description} body is unavailable`);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${description} is too large`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const source = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    totalBytes,
  ).toString("utf8");
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error(`${description} is not valid JSON`);
  }
}
