import { decodeAsyncStatusWidget } from "./async-status-adapter.ts";
import type { StructuredWidgetSource } from "./structured-widget.tsx";

type StructuredWidgetDecoder = (lines: readonly string[]) => StructuredWidgetSource | undefined;

const STRUCTURED_WIDGET_DECODERS: readonly StructuredWidgetDecoder[] = [decodeAsyncStatusWidget];

/** 依次尝试公开 schema adapter；未知内容由调用方按普通字符串行渲染。 */
export function decodeStructuredWidget(lines: readonly string[]): StructuredWidgetSource | undefined {
  for (const decode of STRUCTURED_WIDGET_DECODERS) {
    const source = decode(lines);
    if (source) return source;
  }
  return undefined;
}
