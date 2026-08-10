import type { FigmaNode } from '../schemas';

/** Check if a node has any visible IMAGE fills with an imageRef. */
export function hasImageFill(node: FigmaNode): boolean {
  return (
    Array.isArray(node.fills) &&
    node.fills.some(
      (fill) => fill.type === 'IMAGE' && fill.visible !== false && Boolean(fill.imageRef),
    )
  );
}

export interface CompactNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  bounds?: FigmaNode['absoluteBoundingBox'];
  layout?: Record<string, unknown>;
  style?: Record<string, unknown>;
  text?: string;
  componentId?: string;
  childCount: number;
  children?: CompactNode[];
}

export function compactNode(node: FigmaNode, options: { maxDepth?: number; includeHidden?: boolean } = {}, depth = 0): CompactNode | null {
  if (!options.includeHidden && node.visible === false) return null;
  const maxDepth = options.maxDepth ?? 4;
  const children =
    depth < maxDepth
      ? (node.children ?? [])
          .map((child) => compactNode(child, options, depth + 1))
          .filter((child): child is CompactNode => Boolean(child))
      : undefined;

  return {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
    bounds: node.absoluteBoundingBox,
    layout: compactLayout(node),
    style: compactStyle(node),
    text: node.type === 'TEXT' ? node.characters : undefined,
    componentId: node.componentId,
    childCount: node.children?.length ?? 0,
    ...(children?.length ? { children } : {}),
  };
}

export function flattenNodes(node: FigmaNode, options: { includeHidden?: boolean; maxDepth?: number } = {}, depth = 0): FigmaNode[] {
  if (!options.includeHidden && node.visible === false) return [];
  if (depth > (options.maxDepth ?? Infinity)) return [];
  return [node, ...(node.children ?? []).flatMap((child) => flattenNodes(child, options, depth + 1))];
}

function compactLayout(node: FigmaNode): Record<string, unknown> | undefined {
  const layout = {
    layoutMode: node.layoutMode,
    layoutSizingHorizontal: node.layoutSizingHorizontal,
    layoutSizingVertical: node.layoutSizingVertical,
    itemSpacing: node.itemSpacing,
    paddingLeft: node.paddingLeft,
    paddingRight: node.paddingRight,
    paddingTop: node.paddingTop,
    paddingBottom: node.paddingBottom,
  };
  return Object.fromEntries(Object.entries(layout).filter(([, value]) => value !== undefined));
}

function compactStyle(node: FigmaNode): Record<string, unknown> | undefined {
  const style = {
    fills: node.fills,
    strokes: node.strokes,
    effects: node.effects,
    opacity: node.opacity,
    cornerRadius: node.cornerRadius,
    textStyle: node.style,
  };
  const compact = Object.fromEntries(Object.entries(style).filter(([, value]) => value !== undefined));
  return Object.keys(compact).length ? compact : undefined;
}
