import type { FigmaNode, FigmaRectangle, FigmaTypeStyle } from '../schemas';
import { hasImageFill } from '../transform/compactNode';

/** Image reference extracted from node fills. */
export interface ImageRef {
  nodeId: string;
  nodeName: string;
  imageRef?: string;
  scaleMode?: 'FILL' | 'FIT' | 'CROP' | 'TILE' | 'STRETCH';
  width?: number;
  height?: number;
}

/** Parsed component data from a Figma node. */
export interface ParsedComponent {
  name: string;
  type: string;
  nodeId: string;
  visible?: boolean;
  absoluteBoundingBox?: FigmaRectangle;
  componentId?: string;
  properties?: Record<string, unknown>;
  /** Raw componentProperties before key normalization / style merging. */
  propertiesRaw?: Record<string, unknown>;
  text?: string[];
  textStyle?: FigmaTypeStyle;
  hyperlink?: FigmaTypeStyle['hyperlink'];
  reactions?: unknown[];
  interactions?: unknown[];
  images?: ImageRef[];
  children?: ParsedComponent[];
}

/** Full parsed tree with metadata. */
export interface ParsedComponentTree {
  root: ParsedComponent;
  metadata: {
    totalNodes: number;
    textNodes: number;
    instanceNodes: number;
    imageNodes: number;
    maxDepth: number;
  };
}

export interface ParseOptions {
  /** Include hidden (visible=false) nodes. Default: false */
  includeHidden?: boolean;
  /** Max depth to traverse. Default: Infinity */
  maxDepth?: number;
  /** Include component properties. Default: true */
  includeProperties?: boolean;
  /** Include style info in properties. Default: false */
  includeStyles?: boolean;
}

const DEFAULT_OPTIONS: Required<ParseOptions> = {
  includeHidden: false,
  maxDepth: Infinity,
  includeProperties: true,
  includeStyles: false,
};

/** Parser for extracting structured data from Figma nodes. */
export class FigmaNodeParser {
  private options: Required<ParseOptions>;

  constructor(options?: ParseOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** Parse a single node without recursing into children. */
  parseNode(node: FigmaNode): ParsedComponent {
    const parsed: ParsedComponent = {
      name: node.name,
      type: node.type,
      nodeId: node.id,
      visible: node.visible,
      absoluteBoundingBox: node.absoluteBoundingBox,
    };

    if (node.type === 'INSTANCE' && node.componentId) {
      parsed.componentId = node.componentId;
    }

    if (this.options.includeProperties && node.componentProperties) {
      const { normalized, raw } = this.extractComponentProperties(node);
      parsed.properties = normalized;
      parsed.propertiesRaw = raw;
    }

    if (node.type === 'TEXT' && node.characters) {
      parsed.text = [node.characters];
      parsed.textStyle = node.style;
      parsed.hyperlink = node.style?.hyperlink;
    }

    const nodeWithInteractions = node as unknown as {
      reactions?: unknown[];
      interactions?: unknown[];
    };
    if (Array.isArray(nodeWithInteractions.reactions)) {
      parsed.reactions = nodeWithInteractions.reactions;
    }
    if (Array.isArray(nodeWithInteractions.interactions)) {
      parsed.interactions = nodeWithInteractions.interactions;
    }

    const images = this.extractImagesFromNode(node);
    if (images.length > 0) {
      parsed.images = images;
    }

    if (this.options.includeStyles) {
      parsed.properties = {
        ...parsed.properties,
        ...this.extractStyleProperties(node),
      };
    }

    return parsed;
  }

  /** Extract all image references from a node tree. */
  extractImages(node: FigmaNode, depth = 0): ImageRef[] {
    const images: ImageRef[] = [];

    if (!this.options.includeHidden && node.visible === false) {
      return images;
    }

    if (depth > this.options.maxDepth) {
      return images;
    }

    images.push(...this.extractImagesFromNode(node));

    if (node.children) {
      for (const child of node.children) {
        images.push(...this.extractImages(child, depth + 1));
      }
    }

    return images;
  }

  /** Parse entire node tree recursively with stats. */
  parseTree(node: FigmaNode): ParsedComponentTree {
    const stats = {
      totalNodes: 0,
      textNodes: 0,
      instanceNodes: 0,
      imageNodes: 0,
      maxDepth: 0,
    };

    const root = this.parseNodeRecursive(node, 0, stats);

    return {
      root,
      metadata: stats,
    };
  }

  private parseNodeRecursive(
    node: FigmaNode,
    depth: number,
    stats: ParsedComponentTree['metadata'],
  ): ParsedComponent {
    stats.totalNodes++;
    stats.maxDepth = Math.max(stats.maxDepth, depth);

    if (node.type === 'TEXT') stats.textNodes++;
    if (node.type === 'INSTANCE') stats.instanceNodes++;
    if (hasImageFill(node)) stats.imageNodes++;

    const parsed = this.parseNode(node);

    if (depth < this.options.maxDepth && node.children) {
      const children: ParsedComponent[] = [];

      for (const child of node.children) {
        if (!this.options.includeHidden && child.visible === false) {
          continue;
        }

        children.push(this.parseNodeRecursive(child, depth + 1, stats));
      }

      if (children.length > 0) {
        parsed.children = children;
      }
    }

    return parsed;
  }

  private extractImagesFromNode(node: FigmaNode): ImageRef[] {
    const images: ImageRef[] = [];

    if (!node.fills || !Array.isArray(node.fills)) {
      return images;
    }

    for (const fill of node.fills) {
      if (fill.type === 'IMAGE' && fill.visible !== false && fill.imageRef) {
        const imageRef: ImageRef = {
          nodeId: node.id,
          nodeName: node.name,
          imageRef: fill.imageRef,
        };

        if (fill.scaleMode) {
          imageRef.scaleMode = fill.scaleMode;
        }

        if (node.absoluteBoundingBox) {
          imageRef.width = node.absoluteBoundingBox.width;
          imageRef.height = node.absoluteBoundingBox.height;
        }

        images.push(imageRef);
      }
    }

    return images;
  }

  private extractComponentProperties(node: FigmaNode): {
    normalized: Record<string, unknown>;
    raw: Record<string, unknown>;
  } {
    const normalized: Record<string, unknown> = {};
    const raw: Record<string, unknown> = {};

    if (!node.componentProperties) {
      return { normalized, raw };
    }

    for (const [key, value] of Object.entries(node.componentProperties)) {
      const normalizedKey = key.split('#')[0]?.trim() || key;
      const extracted =
        typeof value === 'object' && value !== null && 'value' in value
          ? (value as { value: unknown }).value
          : value;

      raw[key] = extracted;
      normalized[normalizedKey] = extracted;
    }

    return { normalized, raw };
  }

  private extractStyleProperties(node: FigmaNode): Record<string, unknown> {
    const styles: Record<string, unknown> = {};

    if (node.opacity !== undefined && node.opacity !== 1) {
      styles.opacity = node.opacity;
    }

    if (node.cornerRadius !== undefined) {
      styles.cornerRadius = node.cornerRadius;
    }

    if (node.layoutMode && node.layoutMode !== 'NONE') {
      styles.layoutMode = node.layoutMode;
      if (node.itemSpacing) styles.itemSpacing = node.itemSpacing;
      if (node.paddingLeft) styles.paddingLeft = node.paddingLeft;
      if (node.paddingRight) styles.paddingRight = node.paddingRight;
      if (node.paddingTop) styles.paddingTop = node.paddingTop;
      if (node.paddingBottom) styles.paddingBottom = node.paddingBottom;
    }

    if (node.type === 'TEXT' && node.style) {
      styles.textStyle = {
        fontFamily: node.style.fontFamily,
        fontSize: node.style.fontSize,
        fontWeight: node.style.fontWeight,
        textAlign: node.style.textAlignHorizontal,
      };
    }

    return Object.keys(styles).length > 0 ? styles : {};
  }
}

/** Parse a Figma node tree with default options. */
export function parseTree(
  node: FigmaNode,
  options?: ParseOptions,
): ParsedComponentTree {
  const parser = new FigmaNodeParser(options);
  return parser.parseTree(node);
}

/** Extract all images from a Figma node tree. */
export function extractImages(
  node: FigmaNode,
  options?: ParseOptions,
): ImageRef[] {
  const parser = new FigmaNodeParser(options);
  return parser.extractImages(node);
}
