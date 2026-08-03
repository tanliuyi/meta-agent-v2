import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import FileCode2 from "lucide-react/dist/esm/icons/file-code-corner.mjs";
import Folder from "lucide-react/dist/esm/icons/folder.mjs";
import { Fragment, useMemo, useState } from "react";
import type { FileNode } from "../../../../../shared/contracts.ts";
import { Popover } from "../../../shared/ui/popover.tsx";
import { PopoverContent } from "../../../shared/ui/popover-content.tsx";
import { PopoverTrigger } from "../../../shared/ui/popover-trigger.tsx";
import { filePathSegments } from "../panel-model.ts";
import { FileTree } from "./file-tree.tsx";

interface FilePathBreadcrumbProps {
  path: string;
  children: Readonly<Record<string, readonly FileNode[]>>;
  expanded: ReadonlySet<string>;
  onDirectoryOpen(path: string): void;
  onOpen(node: FileNode): void;
  onPinOpen?(node: FileNode): void;
}

/** 文件路径导航；目录节点通过统一 Popover 展示可继续操作的文件树。 */
export function FilePathBreadcrumb({
  path,
  children,
  expanded,
  onDirectoryOpen,
  onOpen,
  onPinOpen,
}: FilePathBreadcrumbProps) {
  const [openDirectory, setOpenDirectory] = useState<string | null>(null);
  const segments = useMemo(() => filePathSegments(path), [path]);

  return (
    <nav className="file-breadcrumb" aria-label="文件路径">
      <ol>
        {segments.map((segment, index) => (
          <Fragment key={segment.path}>
            {index > 0 ? (
              <li className="file-breadcrumb-separator" aria-hidden="true">
                <ChevronRight size={14} />
              </li>
            ) : null}
            <li>
              {segment.directory ? (
                <Popover
                  open={openDirectory === segment.path}
                  onOpenChange={(open) => {
                    setOpenDirectory(open ? segment.path : null);
                    if (open) onDirectoryOpen(segment.path);
                  }}
                >
                  <PopoverTrigger asChild>
                    <button type="button" className="file-breadcrumb-trigger">
                      <Folder size={13} aria-hidden="true" />
                      <span>{segment.label}</span>
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="file-breadcrumb-popover p-0" align="start" sideOffset={2}>
                    {children[segment.path] ? (
                      <div className="file-breadcrumb-tree pl-1">
                        <FileTree
                          nodes={children[segment.path]}
                          children={children}
                          expanded={expanded}
                          active={path}
                          onOpen={(node) => {
                            onOpen(node);
                            if (node.type === "file") setOpenDirectory(null);
                          }}
                          onPinOpen={onPinOpen}
                        />
                      </div>
                    ) : (
                      <p className="file-breadcrumb-status" role="status">
                        正在加载目录
                      </p>
                    )}
                  </PopoverContent>
                </Popover>
              ) : (
                <span className="file-breadcrumb-current" aria-current="page">
                  <FileCode2 size={13} aria-hidden="true" />
                  <span>{segment.label}</span>
                </span>
              )}
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}
