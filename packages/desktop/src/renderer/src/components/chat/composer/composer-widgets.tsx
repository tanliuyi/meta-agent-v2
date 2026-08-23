import type { SessionControlState } from "../../../../../shared/contracts.ts";
import "./composer-widgets.css";
import { StructuredWidget } from "./structured-widget.tsx";
import { decodeStructuredWidget } from "./structured-widget-decoders.ts";

interface ComposerWidgetsProps {
  widgets: SessionControlState["extensionHost"]["widgets"];
  layout?: "embedded" | "external";
}

/** 按 Pi RPC setWidget 的通用字符串行协议渲染插件 widget。 */
export function ComposerWidgets({ widgets, layout = "embedded" }: ComposerWidgetsProps) {
  if (!widgets?.length) return null;
  return (
    <div className="composer-widgets" data-layout={layout}>
      {widgets.map((widget) => {
        const source = decodeStructuredWidget(widget.lines);
        return source ? (
          <StructuredWidget key={widget.key} source={source} />
        ) : (
          <pre className="composer-widget-content" data-widget-key={widget.key} key={widget.key}>
            {widget.lines.join("\n")}
          </pre>
        );
      })}
    </div>
  );
}
