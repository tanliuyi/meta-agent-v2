import { mkdir, open, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { resolveModel } from './config.ts';
import {
  cancelledError,
  describeWriteError,
  ImageGenError,
  isAbortError,
  throwDownloadHttpError,
} from './errors.ts';
import {
  fetchPublicImage,
  MAX_IMAGE_BYTES,
  readImageResponse,
  resolveImageInputs,
  sniffMime,
} from './image-input.ts';
import { getAdapter } from './providers/index.ts';
import type {
  GeneratedImage,
  GenerateImageParams,
  ImageGenResult,
  ImageGenSettings,
  RawImageResult,
  ResolvedProvider,
} from './types.ts';

export type GenerateImageOptions = {
  cwd: string;
  settings: ImageGenSettings;
  fetchImpl?: typeof fetch;
  /** Cancellation signal — propagated to fetches, provider polling, and file writes. */
  signal?: AbortSignal;
  /** Override the wall-clock used for filenames. Useful for tests. */
  now?: () => Date;
};

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export async function generateImage(
  params: GenerateImageParams,
  options: GenerateImageOptions,
): Promise<ImageGenResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  validateParams(params);

  const requested = (options.settings.defaultModel ?? '').trim();
  if (!requested) {
    // Config errors are ImageGenErrors so they survive the body-free log sink
    // with their actionable text — none of them carry secrets/user content.
    throw new ImageGenError(
      'The Desktop image plugin has no defaultModel. Configure it in the plugin settings.',
      'defaultModel not set',
    );
  }

  const resolved = resolveModel(requested, options.settings);
  if ('error' in resolved) throw new ImageGenError(resolved.error, 'model did not resolve');
  if (resolved.provider.api === 'dashscope' && (params.n ?? 1) > 6) {
    throw new ImageGenError(
      'DashScope supports at most 6 images per request.',
      'DashScope image count exceeds 6',
    );
  }

  const toolSelectedOutputDir = params.outputDir !== undefined;
  const outDir = resolveOutputDir(params.outputDir ?? options.settings.outputDir, options.cwd);
  if (toolSelectedOutputDir && !isInsidePath(resolve(options.cwd), outDir)) {
    throw new ImageGenError(
      'Tool-selected outputDir must be inside the current workspace.',
      'output directory outside workspace',
    );
  }

  const adapter = getAdapter(resolved.provider.api);
  const inputs = await resolveImageInputs(params.image, options.cwd, fetchImpl, options.signal);
  const raws = await adapter.generate(
    resolved.provider,
    resolved.remoteId,
    params,
    fetchImpl,
    options.signal,
    inputs,
  );

  if (options.signal?.aborted) throw cancelledError('image generation');

  try {
    await mkdir(outDir, { recursive: true });
    if (toolSelectedOutputDir) await assertInsideWorkspace(outDir, options.cwd);
  } catch (error) {
    if (error instanceof ImageGenError) throw error;
    // The raw fs error embeds the absolute outDir + errno — classify it into a
    // path-free, actionable hint instead of letting it reach a sink verbatim.
    throw describeWriteError('create the output directory', error);
  }

  const stamp = formatStamp(now());
  const baseFilename = sanitizeFilename(params.filename ?? `${resolved.requestedId}-${stamp}`);
  const images: GeneratedImage[] = [];
  try {
    for (let i = 0; i < raws.length; i++) {
      // Re-check before each write: a base64 result never touches fetch, so the
      // signal has no other cancellation point here — without this an abort during
      // multi-image materialize/write would keep writing files and return success.
      if (options.signal?.aborted) throw cancelledError('image generation');
      const raw = raws[i]!;
      const fetched = await materialize(raw, fetchImpl, options.signal);
      if (options.signal?.aborted) throw cancelledError('image generation');
      const ext = MIME_TO_EXT[fetched.mimeType] ?? 'png';
      const suffix = raws.length > 1 ? `-${i + 1}` : '';
      const path = await writeUnique(
        outDir,
        `${baseFilename}${suffix}`,
        ext,
        fetched.bytes,
        options.signal,
      );
      const image: GeneratedImage = { path, mimeType: fetched.mimeType };
      if (raw.revisedPrompt) image.revisedPrompt = raw.revisedPrompt;
      images.push(image);
    }
  } catch (error) {
    try {
      await Promise.all(
        images.map(async ({ path }) => {
          try {
            await unlink(path);
          } catch (cleanupError) {
            if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError;
          }
        }),
      );
    } catch (cleanupError) {
      logCleanupFailure('remove an incomplete image batch', cleanupError);
    }
    throw error;
  }

  return {
    model: resolved.requestedId,
    provider: providerLabel(resolved.provider),
    images,
  };
}

function validateParams(params: GenerateImageParams): void {
  if (!params.prompt.trim() || params.prompt.length > 32_000) {
    throw new ImageGenError(
      'The image prompt must contain 1 to 32,000 characters.',
      'invalid prompt length',
    );
  }
  if (params.n !== undefined && (!Number.isInteger(params.n) || params.n < 1 || params.n > 8)) {
    throw new ImageGenError('Image count must be an integer from 1 to 8.', 'invalid image count');
  }
  if (params.image && params.image.length > 8) {
    throw new ImageGenError('At most 8 reference images are allowed.', 'too many image inputs');
  }
}

function providerLabel(provider: ResolvedProvider): string {
  return provider.id;
}

function logCleanupFailure(operation: string, error: unknown): void {
  console.error(
    `[pi-image-gen] cleanup failed: ${describeWriteError(operation, error).logSummary}`,
  );
}

function resolveOutputDir(configured: string | undefined, cwd: string): string {
  const target = configured && configured.trim().length > 0 ? configured : '.pi/images';
  return isAbsolute(target) ? resolve(target) : resolve(cwd, target);
}

async function assertInsideWorkspace(path: string, cwd: string): Promise<void> {
  const [projectRoot, canonicalPath] = await Promise.all([realpath(cwd), realpath(path)]);
  if (!isInsidePath(projectRoot, canonicalPath)) {
    throw new ImageGenError(
      'Tool-selected outputDir must be inside the current workspace.',
      'output directory outside workspace',
    );
  }
}

function isInsidePath(root: string, candidate: string): boolean {
  const projectRelativePath = relative(root, candidate);
  return !projectRelativePath.startsWith('..') && !isAbsolute(projectRelativePath);
}

function formatStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

function sanitizeFilename(name: string): string {
  const trimmed = name
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '_');
  return trimmed.length > 0 ? trimmed.slice(0, 100) : 'image';
}

/**
 * Atomically write `bytes` to a non-clobbering path for `<stem>.<ext>` in `dir`,
 * returning the absolute path actually written.
 *
 * Uses the `wx` open flag (O_EXCL) so the "does it exist?" check and the create
 * are a single syscall: if the name is already taken the write fails with
 * `EEXIST` and we try `-v2`, `-v3`, … A prior `existsSync`→`writeFile` version
 * had a TOCTOU race — concurrent calls with the same `filename` could observe
 * the same free name and clobber each other, breaking the README's
 * "never overwrites" contract. O_EXCL closes that window: only one racer can
 * create any given name, the losers retry the next suffix.
 *
 * So two calls with `filename: "hero"` yield `hero.png` then `hero-v2.png` — the
 * earlier output is preserved rather than silently replaced.
 */
async function writeUnique(
  dir: string,
  stem: string,
  ext: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<string> {
  for (let v = 1; ; v++) {
    if (signal?.aborted) throw cancelledError('image generation');
    const candidate = resolve(dir, v === 1 ? `${stem}.${ext}` : `${stem}-v${v}.${ext}`);
    let created = false;
    try {
      // `wx`: create-and-fail-if-exists in one atomic operation (no TOCTOU gap).
      const file = await open(candidate, 'wx');
      created = true;
      try {
        await file.writeFile(bytes, { signal });
      } finally {
        await file.close();
      }
      if (signal?.aborted) throw cancelledError('image generation');
      return candidate;
    } catch (error) {
      if (created) {
        try {
          await unlink(candidate);
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
            logCleanupFailure('remove the incomplete image file', cleanupError);
          }
        }
      }
      if (signal?.aborted || isAbortError(error)) {
        throw cancelledError('image generation');
      }
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      // Disk full / permission / invalid path — the raw fs error embeds the
      // absolute candidate path + errno, so classify it into a path-free hint.
      throw describeWriteError('write the image file', error);
    }
  }
}

async function materialize(
  raw: RawImageResult,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (raw.data.kind === 'base64') {
    const bytes = Buffer.from(raw.data.bytes, 'base64');
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new ImageGenError(
        'The generated image exceeds the 25 MB image safety limit.',
        'generated image too large',
      );
    }
    const mimeType = sniffMime(bytes);
    if (!mimeType) {
      throw new ImageGenError(
        'The provider returned data that is not a supported PNG, JPEG, GIF, or WebP image.',
        'generated output is not an image',
      );
    }
    return { bytes, mimeType };
  }
  if (!raw.data.url || !/^https?:\/\//i.test(raw.data.url)) {
    // Do not echo the reference back: a malformed value could be a giant blob or
    // carry a token. State the shape problem without reproducing the value.
    throw new ImageGenError(
      'Provider returned a non-URL image reference. The response shape may have changed.',
      'non-URL image reference',
    );
  }
  const { response, finalUrl } = await fetchPublicImage(
    raw.data.url,
    'generated image',
    fetchImpl,
    signal,
  );
  if (!response.ok) {
    await throwDownloadHttpError('generated image', finalUrl, response);
  }
  const buf = await readImageResponse(response, 'generated image', finalUrl);
  const mimeType = sniffMime(buf);
  if (!mimeType) {
    throw new ImageGenError(
      'The provider returned data that is not a supported PNG, JPEG, GIF, or WebP image.',
      'generated output is not an image',
    );
  }
  return { bytes: buf, mimeType };
}
