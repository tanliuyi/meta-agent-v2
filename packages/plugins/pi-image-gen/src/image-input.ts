import { constants } from "node:fs";
import { lookup } from "node:dns/promises";
import { lstat, open, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { describeDownloadError, ImageGenError, throwDownloadHttpError } from './errors.ts';
import type { ResolvedImageInput } from './types.ts';

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_BASE64_IMAGE_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
export const MAX_GENERATED_IMAGES = 10;

const MAGIC_BYTES: Array<{ mimeType: string; bytes: number[] }> = [
  { mimeType: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mimeType: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mimeType: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  // WebP: "RIFF....WEBP" — bytes 0..3 = RIFF, bytes 8..11 = WEBP
  { mimeType: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] },
];

const DATA_URI_RE = /^data:(image\/[a-z+.-]+);base64,(.+)$/i;

export async function resolveImageInputs(
  raw: string[] | undefined,
  cwd: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<ResolvedImageInput[]> {
  if (!raw || raw.length === 0) return [];
  const out: ResolvedImageInput[] = [];
  for (let index = 0; index < raw.length; index++) {
    const inputLabel = raw.length > 1 ? `Image input #${index + 1}` : 'Image input';
    out.push(await resolveOne(raw[index]!, inputLabel, cwd, fetchImpl, signal));
  }
  return out;
}

async function resolveOne(
  value: string,
  inputLabel: string,
  cwd: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<ResolvedImageInput> {
  const trimmed = value.trim();
  const logLabel = inputLabel.toLowerCase();
  // Every throw below is an ImageGenError so it survives the body-free log sink
  // (toLogSummary) with an actionable message; none interpolate the raw value —
  // an image input could be a giant base64 blob or a signed URL.
  if (!trimmed) {
    throw new ImageGenError(`${inputLabel} is empty.`, `${logLabel} empty`);
  }

  // Reject base64 / data: URIs — tool-call payloads don't survive megabyte-sized
  // string arguments cleanly across providers. Force callers to point us at a
  // path or URL instead, which is also what /image_generate's tool description
  // tells the model.
  if (/^data:/i.test(trimmed)) {
    throw new ImageGenError(
      `${inputLabel} as a \`data:\` URI is not supported. Pass a file path (absolute or relative to cwd) or an http(s) URL instead. If you have raw image bytes, write them to a file under .pi/uploads first and pass that path.`,
      `${logLabel} rejected (data: URI)`,
    );
  }
  // Heuristic for raw base64: long, only base64 chars. Not foolproof but
  // catches the common case where the model dumps a giant base64 blob.
  if (trimmed.length > 256 && !/[\s/\\]/.test(trimmed) && /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new ImageGenError(
      `${inputLabel} looks like a raw base64 blob; this is not supported because it bloats the tool argument. Write the bytes to a file path and pass that path instead.`,
      `${logLabel} rejected (raw base64)`,
    );
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const { response, finalUrl } = await fetchPublicImage(trimmed, logLabel, fetchImpl, signal);
    if (!response.ok) {
      await throwDownloadHttpError(logLabel, finalUrl, response);
    }
    const buf = await readImageResponse(response, logLabel, finalUrl);
    const mimeType = sniffMime(buf);
    if (!mimeType) {
      throw new ImageGenError(
        `${inputLabel} is not a supported PNG, JPEG, GIF, or WebP image.`,
        `${logLabel} unsupported image format`,
      );
    }
    return { bytes: buf, mimeType };
  }

  // Anything else — treat as a file path (absolute or relative to cwd).
  const lexicalRoot = resolve(cwd);
  const absolute = isAbsolute(trimmed) ? resolve(trimmed) : resolve(lexicalRoot, trimmed);
  const pathFromRoot = relative(lexicalRoot, absolute);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new ImageGenError(
      `${inputLabel} must be inside the current workspace.`,
      `${logLabel} outside workspace`,
    );
  }

  let bytes: Buffer;
  try {
    const projectRoot = await realpath(cwd).catch(() => lexicalRoot);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      throw new ImageGenError(
        `${inputLabel} must not be a symbolic link.`,
        `${logLabel} rejected (symlink)`,
      );
    }
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) {
      throw new ImageGenError(
        `${inputLabel} must be a readable image file no larger than 25 MB.`,
        `${logLabel} too large or not a file`,
      );
    }

    const file = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const openedInfo = await file.stat();
      const canonicalPath = await realpath(absolute);
      const canonicalInfo = await lstat(canonicalPath);
      const projectRelativePath = relative(projectRoot, canonicalPath);
      if (
        projectRelativePath === ".." ||
        projectRelativePath.startsWith(`..${sep}`) ||
        isAbsolute(projectRelativePath) ||
        !openedInfo.isFile() ||
        canonicalInfo.dev !== openedInfo.dev ||
        canonicalInfo.ino !== openedInfo.ino
      ) {
        throw new ImageGenError(
          `${inputLabel} must be a regular image file inside the current workspace.`,
          `${logLabel} rejected (outside workspace or changed file)`,
        );
      }
      if (openedInfo.size > MAX_IMAGE_BYTES) {
        throw new ImageGenError(
          `${inputLabel} must be no larger than 25 MB.`,
          `${logLabel} too large`,
        );
      }
      const buffer = Buffer.allocUnsafe(openedInfo.size);
      let offset = 0;
      while (offset < buffer.byteLength) {
        const { bytesRead } = await file.read(
          buffer,
          offset,
          buffer.byteLength - offset,
          null,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const probe = Buffer.allocUnsafe(1);
      const { bytesRead: extraBytes } = await file.read(probe, 0, 1, null);
      if (extraBytes > 0) {
        throw new ImageGenError(
          `${inputLabel} changed while it was being read. Try again after the file is stable.`,
          `${logLabel} changed while reading`,
        );
      }
      bytes = buffer.subarray(0, offset);
    } finally {
      await file.close();
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new ImageGenError(
        `${inputLabel} must be no larger than 25 MB.`,
        `${logLabel} too large`,
      );
    }
  } catch (error) {
    if (error instanceof ImageGenError) throw error;
    // Do NOT interpolate the resolved absolute path or the raw fs error (errno +
    // full path) — both are sensitive and would reach stderr via the plain-Error
    // path. Keep the message body-free, path-free, and actionable.
    throw new ImageGenError(
      `${inputLabel} is not a readable file path or http(s) URL. Pass an absolute path, a path relative to the session cwd, or an http(s) URL.`,
      `${logLabel} not readable`,
    );
  }
  const mimeType = sniffMime(bytes);
  if (!mimeType) {
    throw new ImageGenError(
      `${inputLabel} is not a supported PNG, JPEG, GIF, or WebP image.`,
      `${logLabel} unsupported image format`,
    );
  }
  return { bytes, mimeType };
}

export async function fetchPublicImage(
  initialUrl: string,
  what: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
    await assertPublicUrl(currentUrl, fetchImpl === globalThis.fetch);
    let response: Response;
    try {
      response = await fetchImpl(currentUrl, {
        signal: signal ?? null,
        redirect: "manual",
      });
    } catch (error) {
      throw describeDownloadError(what, currentUrl, { rejected: error });
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: currentUrl };
    }
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location) {
      throw new ImageGenError(
        `${what} returned a redirect without a location.`,
        `${what} invalid redirect`,
      );
    }
    currentUrl = new URL(location, currentUrl).toString();
  }
  throw new ImageGenError(`${what} exceeded 3 redirects.`, `${what} too many redirects`);
}

async function assertPublicUrl(rawUrl: string, resolveHostname: boolean): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ImageGenError("Image URL is invalid.", "invalid image URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new ImageGenError(
      "Image URLs must use HTTP(S) without embedded credentials.",
      "unsafe image URL",
    );
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new ImageGenError("Image URLs must resolve to a public host.", "private image URL");
  }

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new ImageGenError("Image URLs must resolve to a public host.", "private image URL");
    }
    return;
  }
  if (!resolveHostname) return;

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new ImageGenError("Image URL hostname could not be resolved.", "image URL DNS failure");
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address, true))) {
    throw new ImageGenError("Image URLs must resolve to a public host.", "private image URL");
  }
}

function isPrivateAddress(address: string, allowProxyBenchmarkRange = false): boolean {
  const normalized = address.toLowerCase();
  if (normalized.includes(":")) {
    if (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("ff")
    ) {
      return true;
    }
    const embedded = embeddedIpv4Address(normalized);
    return embedded ? isPrivateAddress(embedded, allowProxyBenchmarkRange) : false;
  }
  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return true;
  }
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (!allowProxyBenchmarkRange && a === 198 && (b === 18 || b === 19)) ||
    a! >= 224
  );
}

function embeddedIpv4Address(address: string): string | undefined {
  const dotted = address.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) return dotted;
  const hexadecimal = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hexadecimal) return undefined;
  const high = Number.parseInt(hexadecimal[1]!, 16);
  const low = Number.parseInt(hexadecimal[2]!, 16);
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

export async function readImageResponse(
  res: Response,
  what: string,
  url: string,
): Promise<Uint8Array> {
  const declaredLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw new ImageGenError(
      `${what} exceeds the 25 MB image safety limit.`,
      `${what} download too large`,
    );
  }
  if (!res.body) return new Uint8Array();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new ImageGenError(
          `${what} exceeds the 25 MB image safety limit.`,
          `${what} download too large`,
        );
      }
      chunks.push(value);
    }
    return new Uint8Array(Buffer.concat(chunks, total));
  } catch (error) {
    if (error instanceof ImageGenError) throw error;
    throw describeDownloadError(what, url, { rejected: error });
  } finally {
    reader.releaseLock();
  }
}

export function sniffMime(bytes: Uint8Array): string | undefined {
  for (const { mimeType, bytes: magic } of MAGIC_BYTES) {
    if (bytes.length < magic.length) continue;
    let match = true;
    for (let i = 0; i < magic.length; i++) {
      if (bytes[i] !== magic[i]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    if (mimeType === 'image/webp') {
      // RIFF prefix matched — verify WEBP at offset 8.
      if (
        bytes.length >= 12 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      ) {
        return 'image/webp';
      }
      continue;
    }
    return mimeType;
  }
  return undefined;
}


export function toDataUri(input: ResolvedImageInput): string {
  const b64 = Buffer.from(input.bytes).toString('base64');
  return `data:${input.mimeType};base64,${b64}`;
}

/**
 * Classify a string returned by an image-generation API as either a URL the
 * caller should fetch, or base64 image bytes the caller already has.
 *
 * Different providers / gateways return image output in different shapes:
 *   - http(s):// URL       → fetch it
 *   - `data:image/...;base64,...`  → strip prefix, decode bytes
 *   - bare base64 string (PNG/JPEG/WebP/GIF magic bytes) → decode bytes
 *   - empty / whitespace   → invalid, return null
 *
 * Returning `null` lets adapters skip junk entries (e.g. when a provider's
 * response had `text` parts but no actual image).
 */
export function classifyImageOutput(
  value: string | undefined | null,
): { kind: 'url'; url: string } | { kind: 'base64'; bytes: string; mimeType: string } | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    return { kind: 'url', url: trimmed };
  }

  const dataMatch = DATA_URI_RE.exec(trimmed);
  if (dataMatch) {
    if (dataMatch[2]!.length > MAX_BASE64_IMAGE_CHARS) return null;
    return {
      kind: 'base64',
      bytes: dataMatch[2]!,
      mimeType: dataMatch[1]!.toLowerCase(),
    };
  }

  // Maybe bare base64 — try to decode and sniff. Bail cheaply on anything that
  // can't possibly be an image (too short, contains non-base64 chars).
  if (
    trimmed.length < 16 ||
    trimmed.length > MAX_BASE64_IMAGE_CHARS ||
    /[^A-Za-z0-9+/=\s]/.test(trimmed)
  ) {
    return null;
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(trimmed, 'base64');
  } catch {
    return null;
  }
  if (decoded.length < 8) return null;
  const mimeType = sniffMime(decoded);
  if (!mimeType) return null;
  return { kind: 'base64', bytes: trimmed, mimeType };
}
