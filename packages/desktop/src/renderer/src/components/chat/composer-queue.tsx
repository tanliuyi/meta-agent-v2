import { TextButton } from "@renderer/shared/ui/text-button";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.mjs";
import { usePiQueueItems } from "../../runtime/use-pi-thread-snapshot.ts";

interface ComposerQueueProps {
  onClear(): Promise<void>;
  onError(error: unknown): void;
}

/** 仅响应 Pi queue identity 变化，流式 timeline delta 不会重渲染该列表。 */
export function ComposerQueue({ onClear, onError }: ComposerQueueProps) {
  const items = usePiQueueItems();
  if (items.length === 0) return null;

  return (
    <section className="composer-queue" aria-label="待处理消息" aria-live="polite">
      <header className="composer-queue-header">
        <span>待处理消息</span>
        <span className="composer-queue-count">{items.length}</span>
        <TextButton
          className="composer-queue-clear"
          aria-label="清空待处理消息"
          onClick={() => void onClear().catch(onError)}
        >
          <RotateCcw /> 清空
        </TextButton>
      </header>
      <div className="composer-queue-list" role="list">
        {items.map((item) => (
          <div className="composer-queue-item" data-queue-mode={item.mode} key={item.id} role="listitem">
            <span className="composer-queue-mode">{item.mode === "steer" ? "引导" : "排队"}</span>
            <span className="composer-queue-prompt" title={item.prompt}>
              {item.prompt}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
