export interface ParsedFigmaReference {
  input: string;
  fileKey: string;
  nodeId?: string;
  fileName?: string;
  isUrl: boolean;
}

const FIGMA_PATH_TYPES = new Set(['design', 'file', 'proto', 'board', 'slides']);

export function normalizeFigmaNodeId(nodeId?: string): string | undefined {
  return nodeId?.trim().replace(/-/g, ':') || undefined;
}

export function parseFigmaReference(input: string, nodeId?: string): ParsedFigmaReference {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Figma URL or file key is required.');
  }

  const explicitNodeId = normalizeFigmaNodeId(nodeId);

  if (!/^https?:\/\//i.test(trimmed) && !trimmed.includes('figma.com/')) {
    return {
      input,
      fileKey: trimmed,
      nodeId: explicitNodeId,
      isUrl: false,
    };
  }

  const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  if (url.hostname !== 'figma.com' && !url.hostname.endsWith('.figma.com')) {
    throw new Error(`Not a Figma URL: ${input}`);
  }

  const parts = url.pathname.split('/').filter(Boolean);
  const typeIndex = parts.findIndex((part) => FIGMA_PATH_TYPES.has(part));
  const fileKey = typeIndex >= 0 ? parts[typeIndex + 1] : undefined;
  if (!fileKey) {
    throw new Error(`Invalid Figma URL - missing file key: ${input}`);
  }

  return {
    input,
    fileKey,
    nodeId: explicitNodeId ?? normalizeFigmaNodeId(url.searchParams.get('node-id') ?? undefined),
    fileName: parts[typeIndex + 2] ? decodeURIComponent(parts[typeIndex + 2]) : undefined,
    isUrl: true,
  };
}

export function requireNodeId(reference: ParsedFigmaReference): string {
  if (!reference.nodeId) {
    throw new Error('A Figma node ID is required. Pass a URL with node-id or a nodeId option.');
  }
  return reference.nodeId;
}
