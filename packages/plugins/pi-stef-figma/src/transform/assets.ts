import fs from 'fs';
import path from 'path';
import type { FigmaNode } from '../schemas';
import { flattenNodes } from './compactNode';

export function ensureSafeOutputPath(outputDir: string, allowedRoot = process.cwd()): string {
  if (outputDir.includes('..')) {
    throw new Error('Refusing to write outside the allowed output root.');
  }
  const root = fs.realpathSync(allowedRoot);
  const resolved = path.resolve(root, outputDir);
  const existingParent = nearestExistingParent(resolved);
  const realParent = fs.realpathSync(existingParent);
  if (realParent !== root && !realParent.startsWith(`${root}${path.sep}`)) {
    throw new Error('Refusing to write outside the allowed output root.');
  }
  return resolved;
}

function nearestExistingParent(target: string): string {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

export function extractAssetManifest(root: FigmaNode, options: { includeHidden?: boolean; maxDepth?: number } = {}): unknown[] {
  return flattenNodes(root, options)
    .filter((node) => node.fills?.some((fill) => fill.type === 'IMAGE' && fill.imageRef))
    .map((node) => ({
      nodeId: node.id,
      name: node.name,
      bounds: node.absoluteBoundingBox,
      imageRefs: node.fills
        ?.filter((fill) => fill.type === 'IMAGE' && fill.imageRef)
        .map((fill) => ({ imageRef: fill.imageRef, scaleMode: fill.scaleMode })),
    }));
}

export async function downloadImageUrls(
  images: Record<string, string | null>,
  outputDir: string,
  allowedRoot = process.cwd(),
  maxBytes = 50 * 1024 * 1024,
): Promise<Array<{ nodeId: string; path: string; skipped?: string }>> {
  const safeDir = ensureSafeOutputPath(outputDir, allowedRoot);
  await fs.promises.mkdir(safeDir, { recursive: true, mode: 0o700 });
  const downloads: Array<{ nodeId: string; path: string; skipped?: string }> = [];

  for (const [nodeId, url] of Object.entries(images)) {
    if (!url) {
      downloads.push({ nodeId, path: '', skipped: 'No render URL returned by Figma.' });
      continue;
    }
    const response = await fetch(url);
    if (!response.ok) {
      downloads.push({ nodeId, path: '', skipped: `Download failed with ${response.status}.` });
      continue;
    }
    const contentLength = Number(response.headers.get('Content-Length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      downloads.push({ nodeId, path: '', skipped: `Download exceeds ${maxBytes} bytes.` });
      continue;
    }
    const extension = getUrlExtension(url);
    const filename = `${nodeId.replace(/[^a-z0-9_-]+/gi, '_')}.${extension}`;
    const filePath = path.join(safeDir, filename);
    const bytes = await readLimitedBytes(response, maxBytes);
    await fs.promises.writeFile(filePath, bytes, { mode: 0o600 });
    downloads.push({ nodeId, path: filePath });
  }

  return downloads;
}

function getUrlExtension(url: string): string {
  const pathname = new URL(url).pathname;
  const match = /\.([a-z0-9]{1,8})$/i.exec(pathname);
  return match?.[1] ?? 'bin';
}

async function readLimitedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`Download exceeds ${maxBytes} bytes.`);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Download exceeds ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
