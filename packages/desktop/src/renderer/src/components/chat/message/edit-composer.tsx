import { ComposerPrimitive, MessagePrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { Button } from "@renderer/shared/ui/button";

export function EditComposer() {
  const aui = useAui();
  const canSend = useAuiState((state) => state.composer.canSend);
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const canQueue = useAuiState((state) => state.thread.capabilities.queue);

  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="flex flex-col px-2 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <ComposerPrimitive.Root className="aui-edit-composer-root border-border/60 dark:border-muted-foreground/15 ms-auto flex w-full max-w-[85%] flex-col rounded-(--composer-radius) border bg-(--composer-background) shadow-(--elevation-composer)">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm outline-none"
          autoFocus
        />
        <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm" className="h-8 rounded-full px-3.5">
              取消
            </Button>
          </ComposerPrimitive.Cancel>
          <Button
            size="sm"
            className="h-8 rounded-full px-3.5"
            disabled={!canSend || (isRunning && !canQueue)}
            onClick={() => aui.composer().send({ startRun: true })}
          >
            更新
          </Button>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
}
