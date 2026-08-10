import { FigmaApi } from './FigmaApi';
import { FigmaNodeParser, ParsedComponent } from './FigmaNodeParser';
import type { FigmaNode } from '../schemas';
import { hasImageFill } from '../transform/compactNode';

export type FigmaContextFormat = 'json' | 'markdown';
export type FigmaContextMode = 'screen' | 'overview';
export type FigmaOverviewState =
  | 'default'
  | 'error'
  | 'empty'
  | 'loading'
  | 'success'
  | 'confirmation'
  | 'selected'
  | 'review';

export interface FigmaContextOptions {
  url?: string;
  mode?: FigmaContextMode;
  format?: FigmaContextFormat;
  out?: string;
  includeRaw?: boolean;
  includeHidden?: boolean;
  includeStyles?: boolean;
  maxDepth?: number;
  maxScreens?: number;
  maxTextPerScreen?: number;
  signal?: AbortSignal;
}

export interface FigmaContextOutput {
  source: {
    url: string;
    fileKey: string;
    nodeId: string;
    extractedAt: string;
  };
  metadata: {
    rootName: string;
    rootType: string;
    totalNodes: number;
    textNodes: number;
    instanceNodes: number;
    imageNodes: number;
    maxDepth: number;
  };
  tree: ParsedComponent;
  components: FigmaContextComponent[];
  textNodes: FigmaContextTextNode[];
  imageRefs: FigmaContextImageRef[];
  rawTree?: FigmaNode;
}

export interface FigmaOverviewOutput {
  source: FigmaContextOutput['source'];
  metadata: {
    rootName: string;
    rootType: string;
    totalNodes: number;
    topLevelNodes: number;
    screenCount: number;
    maxDepth: number;
  };
  screens: FigmaOverviewScreen[];
  rawTree?: FigmaNode;
}

export type FigmaContextResult = FigmaContextOutput | FigmaOverviewOutput;

export interface FigmaOverviewScreen {
  nodeId: string;
  name: string;
  type: string;
  depth: number;
  path: string[];
  visible?: boolean;
  bounds?: ParsedComponent['absoluteBoundingBox'];
  detectedState: FigmaOverviewState;
  childSections: string[];
  keyText: string[];
  textNodeCount: number;
  componentCount: number;
  imageRefCount: number;
}

export interface FigmaContextComponent {
  nodeId: string;
  name: string;
  type: string;
  depth: number;
  path: string[];
  visible?: boolean;
  componentId?: string;
  bounds?: ParsedComponent['absoluteBoundingBox'];
  properties?: Record<string, unknown>;
  text: string[];
  imageRefs: FigmaContextImageRef[];
}

export interface FigmaContextTextNode {
  nodeId: string;
  name: string;
  characters: string;
  depth: number;
  path: string[];
  visible?: boolean;
  bounds?: ParsedComponent['absoluteBoundingBox'];
  textStyle?: ParsedComponent['textStyle'];
  hyperlink?: ParsedComponent['hyperlink'];
}

export interface FigmaContextImageRef {
  nodeId: string;
  nodeName: string;
  depth: number;
  path: string[];
  imageRef?: string;
  scaleMode?: 'FILL' | 'FIT' | 'CROP' | 'TILE' | 'STRETCH';
  width?: number;
  height?: number;
}

interface WalkContext {
  depth: number;
  path: string[];
}

interface RawNodeSummary {
  totalNodes: number;
  textNodes: number;
  componentCount: number;
  imageRefCount: number;
  maxDepth: number;
}

interface OverviewCandidate {
  node: FigmaNode;
  path: string[];
  depth: number;
}

const SCREEN_CANDIDATE_TYPES = new Set([
  'FRAME',
  'SECTION',
  'COMPONENT',
  'COMPONENT_SET',
  'INSTANCE',
]);

const OVERVIEW_SCREEN_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET']);

const OVERVIEW_SECTION_TYPES = new Set([
  'FRAME',
  'GROUP',
  'SECTION',
  'COMPONENT',
  'COMPONENT_SET',
  'INSTANCE',
]);

function collectTextValues(node: ParsedComponent): string[] {
  const values = [...(node.text ?? [])];

  for (const child of node.children ?? []) {
    values.push(...collectTextValues(child));
  }

  return values.filter((value) => value.trim().length > 0);
}

function collectImageRefs(
  node: ParsedComponent,
  ctx: WalkContext,
  results: FigmaContextImageRef[] = [],
): FigmaContextImageRef[] {
  for (const image of node.images ?? []) {
    results.push({
      nodeId: image.nodeId,
      nodeName: image.nodeName,
      depth: ctx.depth,
      path: ctx.path,
      imageRef: image.imageRef,
      scaleMode: image.scaleMode,
      width: image.width,
      height: image.height,
    });
  }

  for (const child of node.children ?? []) {
    collectImageRefs(
      child,
      { depth: ctx.depth + 1, path: [...ctx.path, child.name] },
      results,
    );
  }

  return results;
}

function walkContextTree(
  node: ParsedComponent,
  ctx: WalkContext,
  output: {
    components: FigmaContextComponent[];
    textNodes: FigmaContextTextNode[];
    imageRefs: FigmaContextImageRef[];
  },
): void {
  if (
    node.type === 'INSTANCE' ||
    node.type === 'COMPONENT' ||
    node.type === 'COMPONENT_SET'
  ) {
    output.components.push({
      nodeId: node.nodeId,
      name: node.name,
      type: node.type,
      depth: ctx.depth,
      path: ctx.path,
      visible: node.visible,
      componentId: node.componentId,
      bounds: node.absoluteBoundingBox,
      properties: node.properties,
      text: collectTextValues(node),
      imageRefs: collectImageRefs(node, ctx),
    });
  }

  if (node.type === 'TEXT' && node.text?.length) {
    output.textNodes.push({
      nodeId: node.nodeId,
      name: node.name,
      characters: node.text.join('\n'),
      depth: ctx.depth,
      path: ctx.path,
      visible: node.visible,
      bounds: node.absoluteBoundingBox,
      textStyle: node.textStyle,
      hyperlink: node.hyperlink,
    });
  }

  for (const image of node.images ?? []) {
    output.imageRefs.push({
      nodeId: image.nodeId,
      nodeName: image.nodeName,
      depth: ctx.depth,
      path: ctx.path,
      imageRef: image.imageRef,
      scaleMode: image.scaleMode,
      width: image.width,
      height: image.height,
    });
  }

  for (const child of node.children ?? []) {
    walkContextTree(
      child,
      { depth: ctx.depth + 1, path: [...ctx.path, child.name] },
      output,
    );
  }
}

function assertFigmaUrl(url?: string): asserts url is string {
  if (!url) {
    throw new Error('Figma URL is required. Pass a URL argument or --url.');
  }
}

async function fetchFigmaNode(
  options: FigmaContextOptions,
  deps: { figmaApi?: FigmaApi } = {},
): Promise<{
  figmaApi: FigmaApi;
  url: string;
  fileKey: string;
  nodeId: string;
  figmaNode: FigmaNode;
}> {
  assertFigmaUrl(options.url);

  const figmaApi = deps.figmaApi ?? new FigmaApi();
  const { fileKey, nodeId } = figmaApi.parseUrl(options.url);
  const requestInit = options.signal ? { signal: options.signal } : undefined;
  const figmaNode = await figmaApi.getNodeByUrl(options.url, requestInit);

  return { figmaApi, url: options.url, fileKey, nodeId, figmaNode };
}

function isVisibleNode(node: FigmaNode, includeHidden: boolean): boolean {
  return includeHidden || node.visible !== false;
}

function summarizeRawNode(
  node: FigmaNode,
  options: { includeHidden: boolean; maxDepth: number },
  depth = 0,
): RawNodeSummary {
  if (!isVisibleNode(node, options.includeHidden) || depth > options.maxDepth) {
    return {
      totalNodes: 0,
      textNodes: 0,
      componentCount: 0,
      imageRefCount: 0,
      maxDepth: Math.max(0, depth - 1),
    };
  }

  const summary: RawNodeSummary = {
    totalNodes: 1,
    textNodes: node.type === 'TEXT' ? 1 : 0,
    componentCount:
      node.type === 'INSTANCE' ||
      node.type === 'COMPONENT' ||
      node.type === 'COMPONENT_SET'
        ? 1
        : 0,
    imageRefCount: hasImageFill(node) ? 1 : 0,
    maxDepth: depth,
  };

  for (const child of node.children ?? []) {
    const childSummary = summarizeRawNode(child, options, depth + 1);
    summary.totalNodes += childSummary.totalNodes;
    summary.textNodes += childSummary.textNodes;
    summary.componentCount += childSummary.componentCount;
    summary.imageRefCount += childSummary.imageRefCount;
    summary.maxDepth = Math.max(summary.maxDepth, childSummary.maxDepth);
  }

  return summary;
}

function getNodeText(node: FigmaNode): string | null {
  if (node.type !== 'TEXT' || !node.characters) return null;

  const text = node.characters.trim();
  return text.length > 0 ? text : null;
}

function collectRawText(
  node: FigmaNode,
  options: {
    includeHidden: boolean;
    maxDepth: number;
    maxText: number;
  },
  depth = 0,
  results: string[] = [],
): string[] {
  if (
    results.length >= options.maxText ||
    !isVisibleNode(node, options.includeHidden) ||
    depth > options.maxDepth
  ) {
    return results;
  }

  const text = getNodeText(node);
  if (text && !results.includes(text)) {
    results.push(text);
  }

  for (const child of node.children ?? []) {
    if (results.length >= options.maxText) break;
    collectRawText(child, options, depth + 1, results);
  }

  return results;
}

function collectChildSections(node: FigmaNode, maxSections = 12): string[] {
  const sections: string[] = [];

  for (const child of node.children ?? []) {
    if (sections.length >= maxSections) break;
    if (!OVERVIEW_SECTION_TYPES.has(child.type)) continue;
    if (!child.name.trim() || sections.includes(child.name)) continue;
    sections.push(child.name);
  }

  return sections;
}

function detectOverviewState(name: string, keyText: string[]): FigmaOverviewState {
  const haystack = `${name}\n${keyText.join('\n')}`.toLowerCase();

  if (/error|invalid|required|failed|failure|must enter|must make/.test(haystack)) {
    return 'error';
  }
  if (/empty|no results|no transactions|no activity|none found/.test(haystack)) {
    return 'empty';
  }
  if (/loading|skeleton|spinner|pending/.test(haystack)) {
    return 'loading';
  }
  if (/success|complete|completed|done|approved/.test(haystack)) {
    return 'success';
  }
  if (/confirm|confirmation|review/.test(haystack)) {
    return haystack.includes('review') ? 'review' : 'confirmation';
  }
  if (/selected|active state|checked/.test(haystack)) {
    return 'selected';
  }

  return 'default';
}

function isScreenCandidate(node: FigmaNode): boolean {
  return SCREEN_CANDIDATE_TYPES.has(node.type);
}

function isOverviewScreenCandidate(node: FigmaNode): boolean {
  const bounds = node.absoluteBoundingBox;
  const screenSized = !bounds || (bounds.width >= 240 && bounds.height >= 320);

  if (OVERVIEW_SCREEN_TYPES.has(node.type)) return screenSized;

  if (node.type !== 'INSTANCE') return false;

  const screenNamed = /screen|page|modal|desktop|mobile|open account|^m \|/i.test(
    node.name,
  );

  return screenSized && screenNamed;
}

function sortByCanvasPosition(a: FigmaNode, b: FigmaNode): number {
  const aBounds = a.absoluteBoundingBox;
  const bBounds = b.absoluteBoundingBox;

  if (!aBounds || !bBounds) return a.name.localeCompare(b.name);

  const rowTolerance = Math.max(
    200,
    Math.min(aBounds.height || 0, bBounds.height || 0) / 2,
  );
  const sameRow = Math.abs(aBounds.y - bBounds.y) <= rowTolerance;

  if (sameRow) return aBounds.x - bBounds.x;
  return aBounds.y - bBounds.y;
}

function sortCandidatesByCanvasPosition(
  a: OverviewCandidate,
  b: OverviewCandidate,
): number {
  return sortByCanvasPosition(a.node, b.node);
}

function collectOverviewCandidates(
  node: FigmaNode,
  path: string[],
  depth: number,
): OverviewCandidate[] {
  if (depth > 0 && isOverviewScreenCandidate(node)) {
    return [{ node, path, depth }];
  }

  const candidates = (node.children ?? []).flatMap((child) =>
    collectOverviewCandidates(child, [...path, child.name], depth + 1),
  );

  if (candidates.length > 0) return candidates;

  if (depth === 1 && isScreenCandidate(node)) {
    return [{ node, path, depth }];
  }

  return [];
}

function getOverviewCandidates(root: FigmaNode): OverviewCandidate[] {
  if (isOverviewScreenCandidate(root)) {
    return [{ node: root, path: [root.name], depth: 0 }];
  }

  return collectOverviewCandidates(root, [root.name], 0).sort(
    sortCandidatesByCanvasPosition,
  );
}

function toOverviewScreen(
  candidate: OverviewCandidate,
  options: {
    includeHidden: boolean;
    maxDepth: number;
    maxTextPerScreen: number;
  },
): FigmaOverviewScreen {
  const { node } = candidate;
  const keyText = collectRawText(node, {
    includeHidden: options.includeHidden,
    maxDepth: options.maxDepth,
    maxText: options.maxTextPerScreen,
  });
  const summary = summarizeRawNode(node, {
    includeHidden: options.includeHidden,
    maxDepth: options.maxDepth,
  });

  return {
    nodeId: node.id,
    name: node.name,
    type: node.type,
    depth: candidate.depth,
    path: candidate.path,
    visible: node.visible,
    bounds: node.absoluteBoundingBox,
    detectedState: detectOverviewState(node.name, keyText),
    childSections: collectChildSections(node),
    keyText,
    textNodeCount: summary.textNodes,
    componentCount: summary.componentCount,
    imageRefCount: summary.imageRefCount,
  };
}

export async function buildFigmaContext(
  options: FigmaContextOptions,
  deps: {
    figmaApi?: FigmaApi;
    nodeParser?: FigmaNodeParser;
  } = {},
): Promise<FigmaContextOutput> {
  const { url, fileKey, nodeId, figmaNode } = await fetchFigmaNode(
    options,
    deps,
  );
  const nodeParser =
    deps.nodeParser ??
    new FigmaNodeParser({
      includeHidden: options.includeHidden ?? false,
      includeStyles: options.includeStyles ?? true,
      maxDepth: options.maxDepth ?? Infinity,
    });
  const parsedTree = nodeParser.parseTree(figmaNode);

  const collected = {
    components: [] as FigmaContextComponent[],
    textNodes: [] as FigmaContextTextNode[],
    imageRefs: [] as FigmaContextImageRef[],
  };

  walkContextTree(
    parsedTree.root,
    { depth: 0, path: [parsedTree.root.name] },
    collected,
  );

  return {
    source: {
      url,
      fileKey,
      nodeId,
      extractedAt: new Date().toISOString(),
    },
    metadata: {
      rootName: parsedTree.root.name,
      rootType: parsedTree.root.type,
      totalNodes: parsedTree.metadata.totalNodes,
      textNodes: parsedTree.metadata.textNodes,
      instanceNodes: parsedTree.metadata.instanceNodes,
      imageNodes: parsedTree.metadata.imageNodes,
      maxDepth: parsedTree.metadata.maxDepth,
    },
    tree: parsedTree.root,
    components: collected.components,
    textNodes: collected.textNodes,
    imageRefs: collected.imageRefs,
    ...(options.includeRaw ? { rawTree: figmaNode } : {}),
  };
}

export async function buildFigmaOverview(
  options: FigmaContextOptions,
  deps: {
    figmaApi?: FigmaApi;
  } = {},
): Promise<FigmaOverviewOutput> {
  const { url, fileKey, nodeId, figmaNode } = await fetchFigmaNode(
    options,
    deps,
  );
  const includeHidden = options.includeHidden ?? false;
  const maxDepth = options.maxDepth ?? 8;
  const maxScreens = options.maxScreens ?? 50;
  const maxTextPerScreen = options.maxTextPerScreen ?? 12;
  const summary = summarizeRawNode(figmaNode, { includeHidden, maxDepth });
  const screens = getOverviewCandidates(figmaNode)
    .filter((candidate) => isVisibleNode(candidate.node, includeHidden))
    .slice(0, maxScreens)
    .map((candidate) =>
      toOverviewScreen(candidate, {
        includeHidden,
        maxDepth,
        maxTextPerScreen,
      }),
    );

  return {
    source: {
      url,
      fileKey,
      nodeId,
      extractedAt: new Date().toISOString(),
    },
    metadata: {
      rootName: figmaNode.name,
      rootType: figmaNode.type,
      totalNodes: summary.totalNodes,
      topLevelNodes: figmaNode.children?.length ?? 0,
      screenCount: screens.length,
      maxDepth: summary.maxDepth,
    },
    screens,
    ...(options.includeRaw ? { rawTree: figmaNode } : {}),
  };
}

export async function buildFigmaContextForMode(
  options: FigmaContextOptions,
  deps: {
    figmaApi?: FigmaApi;
    nodeParser?: FigmaNodeParser;
  } = {},
): Promise<FigmaContextResult> {
  if (options.mode === 'overview') {
    return buildFigmaOverview(options, deps);
  }

  return buildFigmaContext(options, deps);
}

function isOverviewOutput(output: FigmaContextResult): output is FigmaOverviewOutput {
  return 'screens' in output;
}

function renderScreenMarkdown(output: FigmaContextOutput): string {
  const lines = [
    `# ${output.metadata.rootName}`,
    '',
    `- Source: ${output.source.url}`,
    `- File key: ${output.source.fileKey}`,
    `- Node ID: ${output.source.nodeId}`,
    `- Root type: ${output.metadata.rootType}`,
    `- Nodes: ${output.metadata.totalNodes}`,
    `- Text nodes: ${output.metadata.textNodes}`,
    `- Component instances: ${output.metadata.instanceNodes}`,
    `- Image nodes: ${output.metadata.imageNodes}`,
    '',
    '## Components',
  ];

  if (output.components.length === 0) {
    lines.push('', 'No component instances found.');
  } else {
    for (const component of output.components) {
      lines.push(
        '',
        `### ${component.name}`,
        '',
        `- Node ID: ${component.nodeId}`,
        `- Type: ${component.type}`,
        `- Path: ${component.path.join(' > ')}`,
      );

      if (component.componentId) {
        lines.push(`- Component ID: ${component.componentId}`);
      }

      if (component.text.length > 0) {
        lines.push('', 'Text:');
        for (const text of component.text) {
          lines.push(`- ${text}`);
        }
      }

      if (component.imageRefs.length > 0) {
        lines.push('', `Image refs: ${component.imageRefs.length}`);
      }
    }
  }

  if (output.textNodes.length > 0) {
    lines.push('', '## Text Nodes');
    for (const textNode of output.textNodes) {
      lines.push(
        '',
        `- ${textNode.path.join(' > ')} (${textNode.nodeId}): ${textNode.characters}`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

function renderOverviewMarkdown(output: FigmaOverviewOutput): string {
  const lines = [
    `# Figma Overview: ${output.metadata.rootName}`,
    '',
    `- Source: ${output.source.url}`,
    `- File key: ${output.source.fileKey}`,
    `- Node ID: ${output.source.nodeId}`,
    `- Root type: ${output.metadata.rootType}`,
    `- Nodes scanned: ${output.metadata.totalNodes}`,
    `- Top-level nodes: ${output.metadata.topLevelNodes}`,
    `- Screens found: ${output.metadata.screenCount}`,
    '',
    '## Screens',
  ];

  if (output.screens.length === 0) {
    lines.push('', 'No screen candidates found.');
    return `${lines.join('\n')}\n`;
  }

  output.screens.forEach((screen, index) => {
    lines.push(
      '',
      `### ${index + 1}. ${screen.name}`,
      '',
      `- Node ID: ${screen.nodeId}`,
      `- Type: ${screen.type}`,
      `- State: ${screen.detectedState}`,
      `- Path: ${screen.path.join(' > ')}`,
      `- Text nodes: ${screen.textNodeCount}`,
      `- Components: ${screen.componentCount}`,
      `- Image refs: ${screen.imageRefCount}`,
    );

    if (screen.bounds) {
      lines.push(
        `- Bounds: x=${screen.bounds.x}, y=${screen.bounds.y}, width=${screen.bounds.width}, height=${screen.bounds.height}`,
      );
    }

    if (screen.childSections.length > 0) {
      lines.push('', 'Major sections:');
      for (const section of screen.childSections) {
        lines.push(`- ${section}`);
      }
    }

    if (screen.keyText.length > 0) {
      lines.push('', 'Key text:');
      for (const text of screen.keyText) {
        lines.push(`- ${text}`);
      }
    }
  });

  return `${lines.join('\n')}\n`;
}

export function renderFigmaContext(
  output: FigmaContextResult,
  format: FigmaContextFormat,
): string {
  if (format === 'json') {
    return JSON.stringify(output, null, 2);
  }

  return isOverviewOutput(output)
    ? renderOverviewMarkdown(output)
    : renderScreenMarkdown(output);
}
