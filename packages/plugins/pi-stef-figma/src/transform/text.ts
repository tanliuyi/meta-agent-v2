import type { FigmaNode } from '../schemas';
import { flattenNodes } from './compactNode';

export interface ExtractedTextNode {
  nodeId: string;
  name: string;
  characters: string;
  path: string[];
}

export function extractTextNodes(root: FigmaNode, options: { includeHidden?: boolean; maxDepth?: number } = {}): ExtractedTextNode[] {
  const results: ExtractedTextNode[] = [];
  walk(root, [root.name], 0, options, results);
  return results;
}

export function findNodesByText(root: FigmaNode, query: string, options: { includeHidden?: boolean; maxDepth?: number } = {}): ExtractedTextNode[] {
  const needle = query.toLowerCase();
  return extractTextNodes(root, options).filter((node) => node.characters.toLowerCase().includes(needle));
}

export function findNodesByName(root: FigmaNode, query: string, options: { includeHidden?: boolean; maxDepth?: number } = {}): Array<{ id: string; name: string; type: string }> {
  const needle = query.toLowerCase();
  return flattenNodes(root, options)
    .filter((node) => node.name.toLowerCase().includes(needle))
    .map((node) => ({ id: node.id, name: node.name, type: node.type }));
}

function walk(
  node: FigmaNode,
  path: string[],
  depth: number,
  options: { includeHidden?: boolean; maxDepth?: number },
  results: ExtractedTextNode[],
): void {
  if (!options.includeHidden && node.visible === false) return;
  if (depth > (options.maxDepth ?? Infinity)) return;
  if (node.type === 'TEXT' && node.characters?.trim()) {
    results.push({ nodeId: node.id, name: node.name, characters: node.characters.trim(), path });
  }
  for (const child of node.children ?? []) {
    walk(child, [...path, child.name], depth + 1, options, results);
  }
}
