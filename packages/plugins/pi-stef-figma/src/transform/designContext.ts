import type { FigmaFileResponse, FigmaNode } from '../schemas';
import { compactNode, flattenNodes } from './compactNode';

export function toDesignContext(file: FigmaFileResponse, options: { maxDepth?: number; includeHidden?: boolean } = {}): unknown {
  const nodes = flattenNodes(file.document, options);
  return {
    file: {
      name: file.name,
      version: file.version,
      lastModified: file.lastModified,
      role: file.role,
    },
    summary: {
      totalNodes: nodes.length,
      pages: (file.document.children ?? []).filter((node) => node.type === 'CANVAS').map((node) => node.name),
      textNodes: nodes.filter((node) => node.type === 'TEXT').length,
      components: nodes.filter((node) => node.type === 'COMPONENT' || node.type === 'INSTANCE').length,
    },
    tree: compactNode(file.document, options),
  };
}

export function summarizeNode(node: FigmaNode, options: { maxDepth?: number; includeHidden?: boolean } = {}): unknown {
  const nodes = flattenNodes(node, options);
  return {
    node: compactNode(node, options),
    summary: {
      totalNodes: nodes.length,
      textNodes: nodes.filter((item) => item.type === 'TEXT').length,
      components: nodes.filter((item) => item.type === 'COMPONENT' || item.type === 'INSTANCE').length,
      imageFills: nodes.filter((item) => item.fills?.some((fill) => fill.type === 'IMAGE')).length,
    },
  };
}
