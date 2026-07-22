import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up.mjs";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";
import Square from "lucide-react/dist/esm/icons/square.mjs";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";
import type { ComposerProps } from "./composer-types.ts";

interface ComposerSubmitControlProps {
  composer: ComposerProps;
  disabled: boolean;
  configLoading: boolean;
  sending: boolean;
  isRunning: boolean;
  loading: boolean;
}

/** 仅订阅发送按钮所需的 Composer 派生布尔值。 */
export function ComposerSubmitControl({
  composer,
  disabled,
  configLoading,
  sending,
  isRunning,
  loading,
}: ComposerSubmitControlProps) {
  const aui = useAui();
  const isEmpty = useAuiState((state) => state.composer.isEmpty);
  const hasText = useAuiState((state) => state.composer.text.trim().length > 0);
  if (composer.mode === "draft") {
    return (
      <TooltipIconButton
        type="submit"
        tooltip={loading ? "正在初始化会话" : "发送消息"}
        side="top"
        variant="default"
        className="size-7 rounded-full"
        disabled={
          disabled ||
          configLoading ||
          isEmpty ||
          !composer.project?.available ||
          !composer.config?.model ||
          composer.config.readiness.state !== "ready"
        }
      >
        {loading ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
      </TooltipIconButton>
    );
  }
  if (isRunning) {
    if (!hasText) {
      return (
        <TooltipIconButton
          type="button"
          tooltip="停止运行"
          side="top"
          variant="default"
          className="size-7 rounded-full"
          disabled={disabled}
          onClick={() => aui.composer().cancel()}
        >
          <Square className="size-4" />
        </TooltipIconButton>
      );
    }
    return (
      <TooltipIconButton
        type="submit"
        tooltip="发送后续消息"
        side="top"
        variant="default"
        className="size-7 rounded-full"
        disabled={disabled || sending || composer.readiness.state !== "ready"}
      >
        <ArrowUp className="size-4" />
      </TooltipIconButton>
    );
  }
  return (
    <ComposerPrimitive.Send asChild>
      <TooltipIconButton
        tooltip="发送消息"
        side="top"
        variant="default"
        className="size-7 rounded-full"
        disabled={disabled}
      >
        <ArrowUp className="size-4" />
      </TooltipIconButton>
    </ComposerPrimitive.Send>
  );
}
