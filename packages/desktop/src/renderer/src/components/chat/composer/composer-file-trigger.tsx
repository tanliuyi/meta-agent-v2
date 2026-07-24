import { ComposerPrimitive, type Unstable_TriggerItem, unstable_useLiveCompletionAdapter } from "@assistant-ui/react";
import File from "lucide-react/dist/esm/icons/file.mjs";
import Folder from "lucide-react/dist/esm/icons/folder.mjs";
import { useCallback } from "react";
import { ComposerFileTriggerState } from "./composer-file-trigger-state.tsx";

interface ComposerFileTriggerProps {
  projectId: string;
  onOpenChange(open: boolean): void;
}

/** Official assistant-ui @ trigger backed by the desktop project file index. */
export function ComposerFileTrigger({ projectId, onOpenChange }: ComposerFileTriggerProps) {
  const fetchFiles = useCallback(
    async (query: string): Promise<readonly Unstable_TriggerItem[]> => {
      const files = await window.desktop.files.list(projectId, "", query);
      return files.slice(0, 10).map((file) => ({
        id: file.path,
        type: file.type,
        label: file.path,
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
      <ComposerPrimitive.Unstable_TriggerPopoverItems>
        {(items) =>
          items.length > 0 ? (
            items.map((item) => (
              <ComposerPrimitive.Unstable_TriggerPopoverItem key={item.id} item={item}>
                {item.type === "directory" ? <Folder size={14} /> : <File size={14} />}
                <strong>{item.label}</strong>
                <span>{item.type === "directory" ? "目录" : "文件"}</span>
              </ComposerPrimitive.Unstable_TriggerPopoverItem>
            ))
          ) : !isLoading ? (
            <div className="composer-suggestions-empty">无匹配文件</div>
          ) : null
        }
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
}
