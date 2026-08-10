import type { FigmaNode } from '../schemas';
import { flattenNodes } from './compactNode';
import { extractTextNodes } from './text';

export function toImplementationContext(root: FigmaNode, options: { includeHidden?: boolean; maxDepth?: number } = {}): unknown {
  const nodes = flattenNodes(root, options);
  const frames = nodes.filter((node) => node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE');
  return {
    target: {
      id: root.id,
      name: root.name,
      type: root.type,
      bounds: root.absoluteBoundingBox,
    },
    layoutHints: frames.map((node) => ({
      id: node.id,
      name: node.name,
      layoutMode: node.layoutMode,
      sizing: {
        horizontal: node.layoutSizingHorizontal,
        vertical: node.layoutSizingVertical,
      },
      spacing: node.itemSpacing,
      padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft],
    })),
    typography: extractTextNodes(root, options).map((node) => ({
      id: node.nodeId,
      text: node.characters,
      path: node.path,
    })),
    assets: nodes
      .filter((node) => node.fills?.some((fill) => fill.type === 'IMAGE' && fill.imageRef))
      .map((node) => ({ id: node.id, name: node.name, bounds: node.absoluteBoundingBox })),
  };
}
