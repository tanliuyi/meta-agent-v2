import type { SessionImageResourceRef } from "../../../shared/contracts.ts";

const SESSION_IMAGE_RESOURCE_PREFIX = "pi-session-image:";

export function toSessionImageResourceUrl(resource: SessionImageResourceRef): string {
  return `${SESSION_IMAGE_RESOURCE_PREFIX}${resource.resourceId}#${encodeURIComponent(resource.mimeType)}`;
}

export function parseSessionImageResourceUrl(value: string | undefined): SessionImageResourceRef | undefined {
  if (!value?.startsWith(SESSION_IMAGE_RESOURCE_PREFIX)) return undefined;
  const separator = value.indexOf("#", SESSION_IMAGE_RESOURCE_PREFIX.length);
  if (separator < 0) return undefined;
  const resourceId = value.slice(SESSION_IMAGE_RESOURCE_PREFIX.length, separator);
  const mimeType = decodeURIComponent(value.slice(separator + 1));
  return resourceId && mimeType ? { resourceId, mimeType } : undefined;
}
