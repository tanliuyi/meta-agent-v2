import { ComposerPrimitive, MessagePrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { Button } from "@renderer/shared/ui/button";
import { type ChangeEvent, type CompositionEvent, useRef, useState } from "react";

export function EditComposer() {
  const aui = useAui();
  const isComposingRef = useRef(false);
  const composerText = useAuiState((state) => state.composer.text);
  const [inputValue, setInputValue] = useState(composerText);
  const canSend = useAuiState((state) => state.composer.canSend);
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const canQueue = useAuiState((state) => state.thread.capabilities.queue);

  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="flex flex-col px-2 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <ComposerPrimitive.Root className="aui-edit-composer-root mt-4 border-border/60 dark:border-muted-foreground/15 ms-auto flex w-full max-w-[85%] flex-col rounded-(--composer-radius) border bg-(--composer-background) shadow-(--elevation-composer)">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm outline-none"
          autoFocus
          value={inputValue}
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={(event: CompositionEvent<HTMLTextAreaElement>) => {
            isComposingRef.current = false;
            setInputValue(event.currentTarget.value);
          }}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
            setInputValue(event.target.value);
            if (isComposingRef.current || event.nativeEvent.isComposing) {
              // Keep assistant-ui from replacing the active IME buffer with its controlled value.
              event.preventDefault();
            }
          }}
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
