import { ComposerPrimitive, type Unstable_TriggerItem, unstable_useLiveCompletionAdapter } from "@assistant-ui/react";
import File from "lucide-react/dist/esm/icons/file.mjs";
import Folder from "lucide-react/dist/esm/icons/folder.mjs";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";
import { useCallback } from "react";
import { ComposerFileTriggerState } from "./composer-file-trigger-state.tsx";
import { fileSuggestions } from "./composer-suggestion-model.ts";

interface ComposerFileTriggerProps {
  projectId: string;
  onOpenChange(open: boolean): void;
}

/** Official assistant-ui @ trigger backed by the desktop project file index. */
export function ComposerFileTrigger({ projectId, onOpenChange }: ComposerFileTriggerProps) {
  const fetchFiles = useCallback(
    async (query: string): Promise<readonly Unstable_TriggerItem[]> => {
      const files = await window.desktop.files.list(projectId, "", query);
      return fileSuggestions(files.slice(0, 10)).map((file) => ({
        id: file.id,
        type: file.type,
        label: file.label,
        description: file.detail,
      }));
    },
    [projectId],
  );
  const { adapter, isLoading } = unstable_useLiveCompletionAdapter({
    fetcher: fetchFiles,
    debounceMs: 200,
  });

  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      char="@"
      adapter={adapter}
      isLoading={isLoading}
      className="composer-suggestions"
      aria-label="文件建议"
    >
      <ComposerPrimitive.Unstable_TriggerPopover.Directive />
      <ComposerFileTriggerState onOpenChange={onOpenChange} />
      <ComposerPrimitive.Unstable_TriggerPopoverItems className="composer-suggestions-scroll">
        {(items) =>
          items.length > 0 ? (
            items.map((item) => (
              <ComposerPrimitive.Unstable_TriggerPopoverItem key={item.id} item={item} className="composer-file-item">
                {item.type === "directory" ? (
                  <Folder className="composer-file-item-icon" size={17} />
                ) : (
                  <File className="composer-file-item-icon" size={17} />
                )}
                <strong title={item.label}>{item.label}</strong>
                {item.description ? <span title={item.description}>{item.description}</span> : null}
              </ComposerPrimitive.Unstable_TriggerPopoverItem>
            ))
          ) : isLoading ? (
            <div className="composer-suggestions-loading" role="status">
              <LoaderCircle size={16} aria-hidden="true" />
              <span>正在加载文件…</span>
            </div>
          ) : (
            <div className="composer-suggestions-empty">无匹配文件</div>
          )
        }
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
}
