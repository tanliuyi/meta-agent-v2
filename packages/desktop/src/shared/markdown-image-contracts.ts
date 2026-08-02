export const MARKDOWN_IMAGE_SCHEME = "meta-agent-markdown-image";

const LOCAL_IMAGE_WITH_SPACES_PATTERN =
  /(!\[[^\]\n]*\]\()((?:\/|file:\/\/\/|[A-Za-z]:[\\/]|\\\\)[^<>\n]*\s[^<>\n]*\.(?:avif|bmp|gif|jpe?g|png|webp))(\))/giu;

export function preprocessMarkdownImages(markdown: string): string {
  return markdown.replace(LOCAL_IMAGE_WITH_SPACES_PATTERN, "$1<$2>$3");
}

export function markdownImageSourceToUrl(source: string): string {
  if (!isProxyableImageSource(source)) return source;
  const normalizedSource = isLocalImageSource(source) ? decodeLocalImageSource(source) : source;
  return `${MARKDOWN_IMAGE_SCHEME}://local/image?source=${encodeURIComponent(normalizedSource)}`;
}

export function markdownImageReference(source: string, alt: string): string {
  const normalizedSource = isLocalImageSource(source) ? decodeLocalImageSource(source) : source;
  const destination = /\s/u.test(normalizedSource) ? `<${normalizedSource}>` : normalizedSource;
  return `![${alt.replaceAll("]", "\\]")}](${destination})`;
}

export function markdownImageFilename(source: string, alt: string): string {
  const sourcePath = imageSourcePath(source);
  const sourceName = decodeLocalImageSource(sourcePath.split(/[\\/]/u).at(-1) ?? "");
  const safeSourceName = safeFilename(sourceName);
  if (safeSourceName) return safeSourceName;
  const safeAlt = safeFilename(alt);
  return safeAlt || "image";
}

function imageSourcePath(source: string): string {
  try {
    return new URL(source).pathname;
  } catch {
    return source;
  }
}

function safeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|]/gu, "-").trim();
}

function decodeLocalImageSource(source: string): string {
  try {
    return decodeURIComponent(source);
  } catch {
    return source;
  }
}

function isProxyableImageSource(source: string): boolean {
  if (isLocalImageSource(source)) return true;
  try {
    const protocol = new URL(source).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function isLocalImageSource(source: string): boolean {
  if (source.startsWith("/") || /^[A-Za-z]:[\\/]/.test(source) || source.startsWith("\\\\")) return true;

  try {
    return new URL(source).protocol === "file:";
  } catch {
    return false;
  }
}
