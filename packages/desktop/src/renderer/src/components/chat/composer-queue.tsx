import { ComposerPrimitive, QueueItemPrimitive, useAuiState } from "@assistant-ui/react";
import { TextButton } from "@renderer/shared/ui/text-button";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.mjs";
import { useMemo } from "react";
import type { PiQueueItem } from "../../../../shared/contracts.ts";

interface ComposerQueueProps {
  items: readonly PiQueueItem[];
  disabled: boolean;
  onClear(): Promise<void>;
  onError(error: unknown): void;
}

/** 使用 assistant-ui queue state 渲染待处理消息，Pi snapshot 只补充 Desktop 的模式标签。 */
export function ComposerQueue({ items, disabled, onClear, onError }: ComposerQueueProps) {
  const queueCount = useAuiState((state) => state.composer.queue.length);
  const modes = useMemo(() => new Map(items.map(({ id, mode }) => [id, mode])), [items]);
  if (queueCount === 0) return null;

  return (
    <section className="composer-queue" aria-label="待处理消息" aria-live="polite">
      <header className="composer-queue-header">
        <span>待处理消息</span>
        <span className="composer-queue-count">{queueCount}</span>
        <TextButton
          className="composer-queue-clear text-[11px] [&_svg]:size-[11px] [&_svg]:opacity-60"
          aria-label="清空待处理消息"
          disabled={disabled}
          onClick={() => void onClear().catch(onError)}
        >
          <RotateCcw /> 清空
        </TextButton>
      </header>
      <div className="composer-queue-list" role="list">
        <ComposerPrimitive.Queue>
          {({ queueItem }) => {
            const mode = modes.get(queueItem.id) ?? "followUp";
            return (
              <div className="composer-queue-item" data-queue-mode={mode} key={queueItem.id} role="listitem">
                <span className="composer-queue-mode">{mode === "steer" ? "引导" : "排队"}</span>
                <QueueItemPrimitive.Text className="composer-queue-prompt" title={queueItem.prompt} />
              </div>
            );
          }}
        </ComposerPrimitive.Queue>
      </div>
    </section>
  );
}
