import { cn } from "@renderer/shared/lib/cn";
import MessageSquareQuote from "lucide-react/dist/esm/icons/message-square-quote.mjs";
import { TooltipIconButton } from "../../assistant-ui/tooltip-icon-button.tsx";

export interface AnnotationModeToggleProps {
  /** 标注模式是否开启（与 aria-pressed/data-active 对应）。 */
  active: boolean;
  /** 切换标注模式：开启态点击即退出。 */
  onToggle: () => void;
}

/**
 * 标注模式工具栏开关：关闭态为 24x24 图标按钮（size=icon，TooltipIconButton 追加
 * size-6 p-1）；开启态用 size=sm 并靠 twMerge 把紧凑尺寸（h-6 w-auto gap-1 px-1.5）
 * 合入 Button 类，避免 CSS 跨 layer 覆盖。仅开启态渲染“正在标注”文本（aria-hidden，
 * 避免与 aria-label/tooltip 重复播报）；关闭态不渲染文本节点，避免 flex gap 残留占位
 * 导致图标左偏。
 */
export function AnnotationModeToggle({ active, onToggle }: AnnotationModeToggleProps) {
  return (
    <TooltipIconButton
      size={active ? "sm" : "icon"}
      tooltip={active ? "退出标注模式" : "开启标注模式"}
      className={cn("browser-annotation-toggle", active && "h-6 w-auto gap-1 px-1.5")}
      data-active={active || undefined}
      aria-label={active ? "退出标注模式" : "开启标注模式"}
      aria-pressed={active}
      onClick={onToggle}
    >
      <MessageSquareQuote size={15} aria-hidden="true" />
      {active && (
        <span className="browser-annotation-toggle-text" aria-hidden={true}>
          正在标注
        </span>
      )}
    </TooltipIconButton>
  );
}
