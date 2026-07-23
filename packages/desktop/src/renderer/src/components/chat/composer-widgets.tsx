import type { SessionControlState } from "../../../../shared/contracts.ts";

interface ComposerWidgetsProps {
  widgets: SessionControlState["extensionHost"]["widgets"];
}

/** 渲染扩展注入到 Composer 上下方的只读文本 widget。 */
export function ComposerWidgets({ widgets }: ComposerWidgetsProps) {
  if (widgets.length === 0) return null;
  return (
    <div className="composer-widgets">
      {widgets.map((widget) => (
        <pre key={widget.key}>{widget.lines.join("\n")}</pre>
      ))}
    </div>
  );
}
