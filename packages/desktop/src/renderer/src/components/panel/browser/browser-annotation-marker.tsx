import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import type { BrowserAnnotation } from "../../../../../shared/browser-contracts.ts";
import { TooltipIconButton } from "../../assistant-ui/tooltip-icon-button.tsx";

interface BrowserAnnotationMarkerProps {
  annotation: BrowserAnnotation;
  /** 序号（1 起），用于徽标与无障碍标签。 */
  index: number;
  onEdit(): void;
  onRemove(): void;
}

/**
 * 已保存标注 marker：语义按钮承载编辑入口（键盘可达），删除按钮为同级兄弟
 * （不嵌套 button），点击删除阻止冒泡避免误触编辑。
 */
export function BrowserAnnotationMarker({ annotation, index, onEdit, onRemove }: BrowserAnnotationMarkerProps) {
  return (
    <div
      className="browser-annotation-marker"
      style={{
        left: `${annotation.bounds.x}px`,
        top: `${annotation.bounds.y}px`,
        width: `${annotation.bounds.width}px`,
        height: `${annotation.bounds.height}px`,
      }}
    >
      <button
        type="button"
        className="browser-annotation-edit-hitbox"
        aria-label={`编辑标注 ${index + 1}`}
        title={annotation.text}
        onClick={onEdit}
      >
        <span className="browser-annotation-badge">{index + 1}</span>
        <span className="browser-annotation-text">{annotation.text}</span>
      </button>
      <span className="browser-annotation-remove-slot">
        <TooltipIconButton
          tooltip={`删除标注 ${index + 1}`}
          aria-label={`删除标注 ${index + 1}`}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <Trash2 size={11} aria-hidden="true" />
        </TooltipIconButton>
      </span>
    </div>
  );
}
