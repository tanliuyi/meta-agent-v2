import { z } from 'zod';

export const FigmaRectangleSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type FigmaRectangle = z.infer<typeof FigmaRectangleSchema>;

export const FigmaColorSchema = z.object({
  r: z.number().min(0).max(1),
  g: z.number().min(0).max(1),
  b: z.number().min(0).max(1),
  a: z.number().min(0).max(1),
});

export const FigmaPaintTypeSchema = z.enum([
  'SOLID',
  'GRADIENT_LINEAR',
  'GRADIENT_RADIAL',
  'GRADIENT_ANGULAR',
  'GRADIENT_DIAMOND',
  'IMAGE',
  'EMOJI',
  'VIDEO',
]);

export const FigmaPaintSchema = z.object({
  type: FigmaPaintTypeSchema,
  visible: z.boolean().optional().default(true),
  opacity: z.number().min(0).max(1).optional().default(1),
  color: FigmaColorSchema.optional(),
  blendMode: z.string().optional(),
  scaleMode: z.enum(['FILL', 'FIT', 'CROP', 'TILE', 'STRETCH']).optional(),
  imageRef: z.string().optional(),
  imageTransform: z.array(z.array(z.number())).optional(),
  scalingFactor: z.number().optional(),
  rotation: z.number().optional(),
  filters: z
    .object({
      exposure: z.number().optional(),
      contrast: z.number().optional(),
      saturation: z.number().optional(),
      temperature: z.number().optional(),
      tint: z.number().optional(),
      highlights: z.number().optional(),
      shadows: z.number().optional(),
    })
    .optional(),
  gradientHandlePositions: z
    .array(z.object({ x: z.number(), y: z.number() }))
    .optional(),
  gradientStops: z
    .array(
      z.object({
        position: z.number(),
        color: FigmaColorSchema,
      }),
    )
    .optional(),
});
export type FigmaPaint = z.infer<typeof FigmaPaintSchema>;

export const FigmaTypeStyleSchema = z.object({
  fontFamily: z.string().optional(),
  fontPostScriptName: z.string().nullable().optional(),
  fontWeight: z.number().optional(),
  fontSize: z.number().optional(),
  textAlignHorizontal: z
    .enum(['LEFT', 'RIGHT', 'CENTER', 'JUSTIFIED'])
    .optional(),
  textAlignVertical: z.enum(['TOP', 'CENTER', 'BOTTOM']).optional(),
  letterSpacing: z.number().optional(),
  lineHeightPx: z.number().optional(),
  lineHeightPercent: z.number().optional(),
  lineHeightPercentFontSize: z.number().optional(),
  lineHeightUnit: z.enum(['PIXELS', 'FONT_SIZE_%', 'INTRINSIC_%']).optional(),
  textCase: z
    .enum([
      'ORIGINAL',
      'UPPER',
      'LOWER',
      'TITLE',
      'SMALL_CAPS',
      'SMALL_CAPS_FORCED',
    ])
    .optional(),
  textDecoration: z.enum(['NONE', 'STRIKETHROUGH', 'UNDERLINE']).optional(),
  italic: z.boolean().optional(),
  fills: z.array(FigmaPaintSchema).optional(),
  hyperlink: z
    .preprocess(
      (val) => {
        if (!val || typeof val !== 'object') return undefined;
        const o = val as Record<string, unknown>;
        const url = typeof o.url === 'string' ? o.url : undefined;
        const nodeIDRaw =
          typeof o.nodeID === 'string'
            ? o.nodeID
            : typeof o.nodeId === 'string'
              ? o.nodeId
              : typeof o.node_id === 'string'
                ? o.node_id
                : undefined;
        const typeRaw = typeof o.type === 'string' ? o.type : undefined;
        const type =
          typeRaw === 'URL' || typeRaw === 'NODE'
            ? typeRaw
            : url
              ? 'URL'
              : nodeIDRaw
                ? 'NODE'
                : undefined;

        if (!type) return undefined;

        return {
          type,
          ...(url ? { url } : {}),
          ...(nodeIDRaw ? { nodeID: nodeIDRaw } : {}),
        };
      },
      z
        .object({
          type: z.enum(['URL', 'NODE']),
          url: z.string().optional(),
          nodeID: z.string().optional(),
        })
        .optional(),
    ),
  opentypeFlags: z.record(z.number()).optional(),
});
export type FigmaTypeStyle = z.infer<typeof FigmaTypeStyleSchema>;

export const FigmaEffectSchema = z.object({
  type: z.enum([
    'INNER_SHADOW',
    'DROP_SHADOW',
    'LAYER_BLUR',
    'BACKGROUND_BLUR',
  ]),
  visible: z.boolean().optional().default(true),
  radius: z.number().optional(),
  color: FigmaColorSchema.optional(),
  blendMode: z.string().optional(),
  offset: z.object({ x: z.number(), y: z.number() }).optional(),
  spread: z.number().optional(),
  showShadowBehindNode: z.boolean().optional(),
});

export const FigmaLayoutConstraintSchema = z.object({
  vertical: z.enum(['TOP', 'BOTTOM', 'CENTER', 'TOP_BOTTOM', 'SCALE']),
  horizontal: z.enum(['LEFT', 'RIGHT', 'CENTER', 'LEFT_RIGHT', 'SCALE']),
});

const FigmaGeometricPropsSchema = z.object({
  absoluteBoundingBox: FigmaRectangleSchema.optional(),
  absoluteRenderBounds: FigmaRectangleSchema.nullable().optional(),
  relativeTransform: z.array(z.array(z.number())).optional(),
  size: z.object({ x: z.number(), y: z.number() }).optional(),
  constraints: FigmaLayoutConstraintSchema.optional(),
  clipsContent: z.boolean().optional(),
});

const FigmaStylePropsSchema = z.object({
  fills: z.array(FigmaPaintSchema).optional(),
  strokes: z.array(FigmaPaintSchema).optional(),
  strokeWeight: z.number().optional(),
  strokeAlign: z.enum(['INSIDE', 'OUTSIDE', 'CENTER']).optional(),
  strokeDashes: z.array(z.number()).optional(),
  opacity: z.number().optional().default(1),
  blendMode: z.string().optional(),
  effects: z.array(FigmaEffectSchema).optional(),
  styles: z.record(z.string()).optional(),
});

const FigmaLayoutPropsSchema = z.object({
  layoutMode: z.enum(['NONE', 'HORIZONTAL', 'VERTICAL', 'GRID']).optional(),
  layoutAlign: z
    .enum(['INHERIT', 'STRETCH', 'MIN', 'CENTER', 'MAX'])
    .optional(),
  layoutGrow: z.number().optional(),
  layoutSizingHorizontal: z.enum(['FIXED', 'HUG', 'FILL']).optional(),
  layoutSizingVertical: z.enum(['FIXED', 'HUG', 'FILL']).optional(),
  layoutPositioning: z.enum(['AUTO', 'ABSOLUTE']).optional(),
  paddingLeft: z.number().optional(),
  paddingRight: z.number().optional(),
  paddingTop: z.number().optional(),
  paddingBottom: z.number().optional(),
  itemSpacing: z.number().optional(),
  counterAxisSpacing: z.number().optional(),
  primaryAxisSizingMode: z.enum(['FIXED', 'AUTO']).optional(),
  counterAxisSizingMode: z.enum(['FIXED', 'AUTO']).optional(),
  primaryAxisAlignItems: z
    .enum(['MIN', 'MAX', 'CENTER', 'SPACE_BETWEEN'])
    .optional(),
  counterAxisAlignItems: z
    .enum(['MIN', 'MAX', 'CENTER', 'BASELINE'])
    .optional(),
  counterAxisAlignContent: z.enum(['AUTO', 'SPACE_BETWEEN']).optional(),
  layoutWrap: z.enum(['NO_WRAP', 'WRAP']).optional(),
});

export type FigmaNode = {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  locked?: boolean;
  pluginData?: Record<string, unknown>;
  sharedPluginData?: Record<string, Record<string, unknown>>;
  absoluteBoundingBox?: FigmaRectangle;
  absoluteRenderBounds?: FigmaRectangle | null;
  relativeTransform?: number[][];
  size?: { x: number; y: number };
  constraints?: z.infer<typeof FigmaLayoutConstraintSchema>;
  clipsContent?: boolean;
  fills?: FigmaPaint[];
  strokes?: FigmaPaint[];
  strokeWeight?: number;
  strokeAlign?: 'INSIDE' | 'OUTSIDE' | 'CENTER';
  strokeDashes?: number[];
  opacity?: number;
  blendMode?: string;
  effects?: z.infer<typeof FigmaEffectSchema>[];
  styles?: Record<string, string>;
  layoutMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'GRID';
  layoutAlign?: 'INHERIT' | 'STRETCH' | 'MIN' | 'CENTER' | 'MAX';
  layoutGrow?: number;
  layoutSizingHorizontal?: 'FIXED' | 'HUG' | 'FILL';
  layoutSizingVertical?: 'FIXED' | 'HUG' | 'FILL';
  layoutPositioning?: 'AUTO' | 'ABSOLUTE';
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  itemSpacing?: number;
  counterAxisSpacing?: number;
  primaryAxisSizingMode?: 'FIXED' | 'AUTO';
  counterAxisSizingMode?: 'FIXED' | 'AUTO';
  primaryAxisAlignItems?: 'MIN' | 'MAX' | 'CENTER' | 'SPACE_BETWEEN';
  counterAxisAlignItems?: 'MIN' | 'MAX' | 'CENTER' | 'BASELINE';
  counterAxisAlignContent?: 'AUTO' | 'SPACE_BETWEEN';
  layoutWrap?: 'NO_WRAP' | 'WRAP';
  children?: FigmaNode[];
  characters?: string;
  style?: z.infer<typeof FigmaTypeStyleSchema>;
  characterStyleOverrides?: number[];
  styleOverrideTable?: Record<number, z.infer<typeof FigmaTypeStyleSchema>>;
  componentId?: string;
  componentPropertyDefinitions?: Record<string, unknown>;
  componentProperties?: Record<string, unknown>;
  overrides?: unknown[];
  isExposedInstance?: boolean;
  cornerRadius?: number;
  rectangleCornerRadii?: number[];
  cornerSmoothing?: number;
  [key: string]: unknown;
};

const baseFigmaNodeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    visible: z.boolean().optional(),
    locked: z.boolean().optional(),
    pluginData: z.record(z.unknown()).optional(),
    sharedPluginData: z.record(z.record(z.unknown())).optional(),
  })
  .merge(FigmaGeometricPropsSchema.partial())
  .merge(FigmaStylePropsSchema.partial())
  .merge(FigmaLayoutPropsSchema.partial())
  .extend({
    characters: z.string().optional(),
    style: FigmaTypeStyleSchema.optional(),
    characterStyleOverrides: z.array(z.number()).optional(),
    styleOverrideTable: z
      .record(z.coerce.number(), FigmaTypeStyleSchema)
      .optional(),
    componentId: z.string().optional(),
    componentPropertyDefinitions: z.record(z.unknown()).optional(),
    componentProperties: z.record(z.unknown()).optional(),
    overrides: z.array(z.unknown()).optional(),
    isExposedInstance: z.boolean().optional(),
    cornerRadius: z.number().optional(),
    rectangleCornerRadii: z.array(z.number()).optional(),
    cornerSmoothing: z.number().optional(),
  })
  .passthrough();

export const FigmaNodeSchema: z.ZodType<FigmaNode> = baseFigmaNodeSchema.extend(
  {
    children: z.lazy(() => z.array(FigmaNodeSchema)).optional(),
  },
) as z.ZodType<FigmaNode>;

export const FigmaFileResponseSchema = z.object({
  name: z.string(),
  lastModified: z.string(),
  thumbnailUrl: z.string().url().optional(),
  version: z.string().optional(),
  role: z.string().optional(),
  document: FigmaNodeSchema,
  components: z.record(z.unknown()).optional(),
  componentSets: z.record(z.unknown()).optional(),
  schemaVersion: z.number().optional(),
  styles: z.record(z.unknown()).optional(),
  mainFileKey: z.string().optional(),
  branches: z.array(z.object({ key: z.string(), name: z.string() })).optional(),
});
export type FigmaFileResponse = z.infer<typeof FigmaFileResponseSchema>;

export const FigmaNodesResponseSchema = z.object({
  name: z.string(),
  lastModified: z.string(),
  thumbnailUrl: z.string().url().optional(),
  version: z.string().optional(),
  role: z.string().optional(),
  nodes: z.record(
    z.object({
      document: FigmaNodeSchema,
      components: z.record(z.unknown()).optional(),
      schemaVersion: z.number().optional(),
      styles: z.record(z.unknown()).optional(),
    }),
  ),
});
export type FigmaNodesResponse = z.infer<typeof FigmaNodesResponseSchema>;
