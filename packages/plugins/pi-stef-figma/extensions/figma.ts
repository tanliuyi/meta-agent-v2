import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { FigmaAuthorization } from '../src/auth/FigmaAuthorization';
import { FigmaCache } from '../src/cache/FigmaCache';
import { FigmaClient } from '../src/client/FigmaClient';
import {
  buildFigmaContextForMode,
  renderFigmaContext,
  type FigmaContextFormat,
} from '../src/context/FigmaContext';
import type { FigmaFileResponse, FigmaNode } from '../src/schemas';
import { cappedJson, textResult } from '../src/toolResult';
import { downloadImageUrls, extractAssetManifest } from '../src/transform/assets';
import { toDesignContext, summarizeNode } from '../src/transform/designContext';
import { toImplementationContext } from '../src/transform/implementationContext';
import { findNodesByName, findNodesByText, extractTextNodes } from '../src/transform/text';
import { summarizeLibraryPayload } from '../src/transform/tokens';
import { parseFigmaReference, requireNodeId } from '../src/url';

const figmaContextParams = Type.Object({
  url: Type.String({
    description: 'Figma browser URL containing a node-id query parameter.',
  }),
  mode: Type.Optional(
    StringEnum(['screen', 'overview'] as const, {
      description:
        'Use screen for a focused frame. Use overview for a page, canvas, worksheet, or multi-screen flow.',
    }),
  ),
  format: Type.Optional(
    StringEnum(['json', 'markdown'] as const, {
      description: 'Output format. Use markdown for compact summaries.',
    }),
  ),
  includeRaw: Type.Optional(Type.Boolean({ description: 'Include raw Figma node payload.' })),
  includeHidden: Type.Optional(Type.Boolean({ description: 'Include hidden nodes.' })),
  includeStyles: Type.Optional(Type.Boolean({ description: 'Include style metadata in parsed nodes.' })),
  maxDepth: Type.Optional(Type.Integer({ minimum: 0, description: 'Max depth to traverse when parsing the node tree.' })),
  maxScreens: Type.Optional(Type.Integer({ minimum: 0, description: 'Max screens to include in overview mode.' })),
  maxTextPerScreen: Type.Optional(Type.Integer({ minimum: 0, description: 'Max key text snippets per screen in overview mode.' })),
});

const referenceParams = Type.Object({
  input: Type.String({ description: 'Figma URL or bare file key.' }),
  nodeId: Type.Optional(Type.String({ description: 'Optional node ID in 1:2 or 1-2 format.' })),
});

const fileParamProperties = {
  input: Type.String({ description: 'Figma URL or bare file key.' }),
  nodeId: Type.Optional(Type.String({ description: 'Optional node ID in 1:2 or 1-2 format.' })),
  depth: Type.Optional(Type.Integer({ minimum: 0 })),
  maxDepth: Type.Optional(Type.Integer({ minimum: 0 })),
  includeHidden: Type.Optional(Type.Boolean()),
  maxResponseChars: Type.Optional(Type.Integer({ minimum: 1000 })),
};

const fileParams = Type.Object(fileParamProperties);

const searchParams = Type.Object({
  ...fileParamProperties,
  query: Type.String({ description: 'Name or text query.' }),
});

interface FigmaContextToolParams {
  url: string;
  mode?: 'screen' | 'overview';
  format?: FigmaContextFormat;
  includeRaw?: boolean;
  includeHidden?: boolean;
  includeStyles?: boolean;
  maxDepth?: number;
  maxScreens?: number;
  maxTextPerScreen?: number;
}

interface ReferenceToolParams {
  input: string;
  nodeId?: string;
}

interface FileToolParams extends ReferenceToolParams {
  depth?: number;
  maxDepth?: number;
  includeHidden?: boolean;
  maxResponseChars?: number;
}

interface SearchToolParams extends FileToolParams {
  query: string;
}

interface RenderToolParams extends FileToolParams {
  nodeIds?: string[];
  format?: 'jpg' | 'png' | 'svg' | 'pdf';
  scale?: number;
  outputDir?: string;
}

interface AuthStatusParams {
  fileKey?: string;
}

/** Host configuration (Desktop extension settings). */
export interface FigmaDesktopConfig {
  /** Figma personal access token; stored as an encrypted secret by Desktop. */
  apiToken?: string;
  /** Optional file key used by figma_auth_status when no explicit fileKey is passed. */
  fileKey?: string;
}

function isDuplicateToolRegistrationError(error: unknown): boolean {
  // TODO: Replace this message heuristic with a typed Pi duplicate-tool error if the host exposes one.
  return error instanceof Error && /already registered|collision|duplicate/i.test(error.message);
}

function registerTool(pi: ExtensionAPI, tool: Parameters<ExtensionAPI['registerTool']>[0]): void {
  try {
    pi.registerTool(tool);
  } catch (error) {
    if (tool.name === 'figma_context' && isDuplicateToolRegistrationError(error)) {
      console.warn(
        'Skipping figma_context registration because another Figma package already registered it. Remove figma-context during migration to enable packages/figma.',
      );
      return;
    }
    throw error;
  }
}

function client(apiToken?: string): FigmaClient {
  return new FigmaClient({ auth: new FigmaAuthorization({ apiToken }), cache: new FigmaCache() });
}

function filterLibraryItems(payload: unknown, key: string, query: string): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const items = (payload as Record<string, unknown>)[key];
  const needle = query.toLowerCase();
  if (Array.isArray(items)) {
    const matches = items.filter((item) => itemMatchesComponentQuery(item, needle)).slice(0, 100);
    return {
      count: matches.length,
      matches,
    };
  }
  if (items && typeof items === 'object') {
    const matches = Object.entries(items as Record<string, unknown>).filter(([name, value]) =>
      itemMatchesComponentQuery({ name, ...(typeof value === 'object' && value ? value : {}) }, needle),
    );
    return { count: matches.length, matches: Object.fromEntries(matches.slice(0, 100)) };
  }
  return payload;
}

function itemMatchesComponentQuery(item: unknown, needle: string): boolean {
  if (!item || typeof item !== 'object') return false;
  const record = item as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name : '';
  const description = typeof record.description === 'string' ? record.description : '';
  return `${name}\n${description}`.toLowerCase().includes(needle);
}

async function getFileForParams(
  params: { input: string; nodeId?: string; depth?: number },
  signal: AbortSignal | undefined,
  apiToken: string | undefined,
): Promise<{
  reference: ReturnType<typeof parseFigmaReference>;
  file: FigmaFileResponse;
}> {
  const reference = parseFigmaReference(params.input, params.nodeId);
  const file = await client(apiToken).getFile(reference.fileKey, {
    depth: params.depth,
    ids: reference.nodeId ? [reference.nodeId] : undefined,
    signal,
  });
  return { reference, file };
}

async function getTargetNode(
  params: { input: string; nodeId?: string; depth?: number },
  signal: AbortSignal | undefined,
  apiToken: string | undefined,
): Promise<{
  reference: ReturnType<typeof parseFigmaReference>;
  node: FigmaNode;
}> {
  const reference = parseFigmaReference(params.input, params.nodeId);
  const nodeId = requireNodeId(reference);
  const response = await client(apiToken).getNodes(reference.fileKey, [nodeId], { depth: params.depth, signal });
  const node = response.nodes[nodeId]?.document;
  if (!node) throw new Error(`Node not found in Figma response: ${nodeId}`);
  return { reference, node };
}

export default function figmaExtension(pi: ExtensionAPI): void {
  const config = pi.getConfig<FigmaDesktopConfig>();
  const apiToken = config.apiToken;
  const clientFor = () => client(apiToken);

  registerTool(pi, {
    name: 'figma_context',
    label: 'Figma Context',
    description: 'Fetch screen-level design context or overview multi-screen Figma flows without MCP.',
    promptSnippet:
      'Read compact Figma design context from a Figma URL. Use overview for broad flow links, then screen for focused deep dives.',
    promptGuidelines: [
      'Use figma_context mode="overview" first when the Figma URL appears to point to a page, canvas, worksheet, or multi-screen flow.',
      'Use figma_context mode="screen" when the URL points to a specific screen/frame or after overview identifies the relevant node.',
      'When implementing from a user story, compare the story intent with overview screen names/states before choosing deep-dive screens.',
      'Prefer format="markdown" for compact summaries and format="json" when structured data is needed.',
    ],
    parameters: figmaContextParams,
    async execute(_toolCallId: string, params: FigmaContextToolParams, signal?: AbortSignal) {
      const format: FigmaContextFormat = params.format ?? 'markdown';
      const output = await buildFigmaContextForMode({
        url: params.url,
        mode: params.mode,
        format,
        includeRaw: params.includeRaw,
        includeHidden: params.includeHidden,
        includeStyles: params.includeStyles,
        maxDepth: params.maxDepth,
        maxScreens: params.maxScreens,
        maxTextPerScreen: params.maxTextPerScreen,
        signal,
      });

      return textResult(renderFigmaContext(output, format), output);
    },
  });

  registerTool(pi, {
    name: 'figma_parse_url',
    label: 'Parse Figma URL',
    description: 'Parse Figma URLs, bare file keys, and node IDs without calling Figma.',
    parameters: referenceParams,
    async execute(_toolCallId: string, params: ReferenceToolParams) {
      const parsed = parseFigmaReference(params.input, params.nodeId);
      return textResult(cappedJson(parsed), parsed);
    },
  });

  registerTool(pi, {
    name: 'figma_auth_status',
    label: 'Figma Auth Status',
    description: 'Check Figma token configuration without printing token values.',
    parameters: Type.Object({
      fileKey: Type.Optional(Type.String({ description: 'Optional file key to verify access with a minimal request.' })),
    }),
    async execute(_toolCallId: string, params: AuthStatusParams, signal?: AbortSignal) {
      const auth = new FigmaAuthorization({ apiToken });
      let configured = false;
      try {
        configured = Boolean(auth.getConfig().apiToken);
      } catch {
        configured = false;
      }
      const details: Record<string, unknown> = {
        configured,
        configPath: 'extension settings (apiToken) or ~/.pi/sf/figma/config.json',
        scopes: ['file_content:read', 'file_comments:read', 'library_assets:read', 'library_content:read'],
      };
      const fileKey = params.fileKey ?? config.fileKey;
      if (fileKey) {
        if (!configured) {
          throw new Error('Figma token is not configured. Set apiToken in the extension settings or create ~/.pi/sf/figma/config.json with { "apiToken": "..." }.');
        }
        await new FigmaClient({ auth }).getFile(fileKey, { depth: 1, signal });
        details.fileAccess = 'ok';
      }
      return textResult(cappedJson(details), details);
    },
  });

  registerTool(pi, {
    name: 'figma_get_design_context',
    label: 'Figma Design Context',
    description: 'Return compact file/page/frame context for design understanding.',
    parameters: fileParams,
    async execute(_toolCallId: string, params: FileToolParams, signal?: AbortSignal) {
      const { file } = await getFileForParams(params, signal, apiToken);
      const details = toDesignContext(file, params);
      return textResult(cappedJson(details, params.maxResponseChars), details);
    },
  });

  registerTool(pi, {
    name: 'figma_get_node_summary',
    label: 'Figma Node Summary',
    description: 'Return compact structured summary for a focused node.',
    parameters: fileParams,
    async execute(_toolCallId: string, params: FileToolParams, signal?: AbortSignal) {
      const { node } = await getTargetNode(params, signal, apiToken);
      const details = summarizeNode(node, params);
      return textResult(cappedJson(details, params.maxResponseChars), details);
    },
  });

  registerTool(pi, {
    name: 'figma_get_implementation_context',
    label: 'Figma Implementation Context',
    description: 'Return coding-ready layout, text, typography, and asset hints.',
    parameters: fileParams,
    async execute(_toolCallId: string, params: FileToolParams, signal?: AbortSignal) {
      const { node } = await getTargetNode(params, signal, apiToken);
      const details = toImplementationContext(node, params);
      return textResult(cappedJson(details, params.maxResponseChars), details);
    },
  });

  registerTool(pi, {
    name: 'figma_extract_text',
    label: 'Figma Text',
    description: 'Extract visible text nodes from a file or focused node.',
    parameters: fileParams,
    async execute(_toolCallId: string, params: FileToolParams, signal?: AbortSignal) {
      const target = params.nodeId ? (await getTargetNode(params, signal, apiToken)).node : (await getFileForParams(params, signal, apiToken)).file.document;
      const details = extractTextNodes(target, params);
      return textResult(cappedJson(details, params.maxResponseChars), details);
    },
  });

  registerTool(pi, {
    name: 'figma_find_nodes_by_name',
    label: 'Find Figma Nodes By Name',
    description: 'Find nodes by layer/name text.',
    parameters: searchParams,
    async execute(_toolCallId: string, params: SearchToolParams, signal?: AbortSignal) {
      const target = params.nodeId ? (await getTargetNode(params, signal, apiToken)).node : (await getFileForParams(params, signal, apiToken)).file.document;
      const details = findNodesByName(target, params.query, params);
      return textResult(cappedJson(details, params.maxResponseChars), details);
    },
  });

  registerTool(pi, {
    name: 'figma_find_nodes_by_text',
    label: 'Find Figma Nodes By Text',
    description: 'Find visible text nodes by text content.',
    parameters: searchParams,
    async execute(_toolCallId: string, params: SearchToolParams, signal?: AbortSignal) {
      const target = params.nodeId ? (await getTargetNode(params, signal, apiToken)).node : (await getFileForParams(params, signal, apiToken)).file.document;
      const details = findNodesByText(target, params.query, params);
      return textResult(cappedJson(details, params.maxResponseChars), details);
    },
  });

  registerTool(pi, {
    name: 'figma_render_nodes',
    label: 'Render Figma Nodes',
    description:
      'Return expiring Figma image render URLs for nodes. When outputDir is provided, downloads files under the current working directory with safe-path checks and private file permissions.',
    parameters: Type.Object({
      ...fileParamProperties,
      format: Type.Optional(
        StringEnum(['jpg', 'png', 'svg', 'pdf'] as const)),
      nodeIds: Type.Optional(Type.Array(Type.String({ description: 'Optional node IDs in 1:2 or 1-2 format.' }))),
      scale: Type.Optional(Type.Number({ minimum: 0.01, maximum: 4 })),
      outputDir: Type.Optional(Type.String({ description: 'Optional safe output directory under the current working directory.' })),
    }),
    async execute(_toolCallId: string, params: RenderToolParams, signal?: AbortSignal) {
      const reference = parseFigmaReference(params.input, params.nodeId);
      const nodeIds = params.nodeIds?.length ? params.nodeIds.map((nodeId) => nodeId.replace(/-/g, ':')) : [requireNodeId(reference)];
      const details = await clientFor().getImageRenderUrls(reference.fileKey, nodeIds, {
        format: params.format,
        scale: params.scale,
        signal,
      });
      if (params.outputDir) {
        const detailsWithDownloads = {
          ...details,
          downloads: await downloadImageUrls(details.images, params.outputDir),
        };
        return textResult(cappedJson(detailsWithDownloads, params.maxResponseChars), detailsWithDownloads);
      }
      return textResult(cappedJson(details, params.maxResponseChars), details);
    },
  });

  registerTool(pi, {
    name: 'figma_extract_assets',
    label: 'Figma Asset Manifest',
    description: 'Return image-fill and renderable asset manifest without writing by default.',
    parameters: fileParams,
    async execute(_toolCallId: string, params: FileToolParams, signal?: AbortSignal) {
      const target = params.nodeId ? (await getTargetNode(params, signal, apiToken)).node : (await getFileForParams(params, signal, apiToken)).file.document;
      const details = extractAssetManifest(target, params);
      return textResult(cappedJson(details, params.maxResponseChars), details);
    },
  });

  const libraryTools = [
    ['figma_get_styles', 'Figma Styles', 'styles', (fileKey: string, signal?: AbortSignal) => clientFor().getStyles(fileKey, signal)],
    ['figma_get_variables', 'Figma Variables', 'variables', (fileKey: string, signal?: AbortSignal) => clientFor().getVariables(fileKey, signal)],
    ['figma_get_components', 'Figma Components', 'components', (fileKey: string, signal?: AbortSignal) => clientFor().getComponents(fileKey, signal)],
    ['figma_get_component_sets', 'Figma Component Sets', 'componentSets', (fileKey: string, signal?: AbortSignal) => clientFor().getComponentSets(fileKey, signal)],
    ['figma_get_comments', 'Figma Comments', 'comments', (fileKey: string, signal?: AbortSignal) => clientFor().getComments(fileKey, signal)],
  ] as const;

  for (const [name, label, key, fetcher] of libraryTools) {
    registerTool(pi, {
      name,
      label,
      description: `Fetch compact ${key} data from the Figma REST API.`,
      parameters: fileParams,
      async execute(_toolCallId: string, params: FileToolParams, signal?: AbortSignal) {
        const reference = parseFigmaReference(params.input, params.nodeId);
        const payload = await fetcher(reference.fileKey, signal);
        const details = summarizeLibraryPayload(payload, key);
        return textResult(cappedJson(details, params.maxResponseChars), details);
      },
    });
  }

  registerTool(pi, {
    name: 'figma_search_components',
    label: 'Search Figma Components',
    description: 'Search compact component metadata by component name.',
    parameters: searchParams,
    async execute(_toolCallId: string, params: SearchToolParams, signal?: AbortSignal) {
      const reference = parseFigmaReference(params.input, params.nodeId);
      const payload = await clientFor().getComponents(reference.fileKey, signal);
      const details = filterLibraryItems(payload, 'components', params.query);
      return textResult(cappedJson(details, params.maxResponseChars), details);
    },
  });

  registerTool(pi, {
    name: 'figma_get_image_fills',
    label: 'Figma Image Fills',
    description: 'Return expiring image-fill URLs from Figma. Results are not cached.',
    parameters: fileParams,
    async execute(_toolCallId: string, params: FileToolParams, signal?: AbortSignal) {
      const reference = parseFigmaReference(params.input, params.nodeId);
      const details = await clientFor().getImageFills(reference.fileKey, signal);
      return textResult(cappedJson(details, params.maxResponseChars), details);
    },
  });

  registerTool(pi, {
    name: 'figma_get_file_raw',
    label: 'Figma Raw File',
    description: 'Debugging escape hatch for capped raw file JSON.',
    parameters: fileParams,
    async execute(_toolCallId: string, params: FileToolParams, signal?: AbortSignal) {
      const { file } = await getFileForParams(params, signal, apiToken);
      return textResult(cappedJson(file, params.maxResponseChars), file);
    },
  });

  registerTool(pi, {
    name: 'figma_get_nodes_raw',
    label: 'Figma Raw Nodes',
    description: 'Debugging escape hatch for capped raw node JSON.',
    parameters: fileParams,
    async execute(_toolCallId: string, params: FileToolParams, signal?: AbortSignal) {
      const reference = parseFigmaReference(params.input, params.nodeId);
      const nodes = await clientFor().getNodes(reference.fileKey, [requireNodeId(reference)], { depth: params.depth, signal });
      return textResult(cappedJson(nodes, params.maxResponseChars), nodes);
    },
  });
}
