import { TooltipIconButton } from "@renderer/components/assistant-ui/tooltip-icon-button";
import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogTitle } from "@renderer/shared/ui/dialog-title";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import Download from "lucide-react/dist/esm/icons/download.mjs";
import Maximize from "lucide-react/dist/esm/icons/maximize.mjs";
import Table from "lucide-react/dist/esm/icons/table.mjs";
import type { ComponentPropsWithoutRef } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { extractTableDataFromElement, tableDataToCSV, tableDataToMarkdown, tableDataToTSV } from "streamdown";

type ExtraProps = { node?: unknown };

export function MarkdownTable({
  children,
  className,
  style,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<"table"> & ExtraProps) {
  const tableRef = useRef<HTMLTableElement>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);

  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const copyTable = useCallback(async (format: "csv" | "tsv" | "md") => {
    const el = tableRef.current;
    if (!el) return;
    const data = extractTableDataFromElement(el);
    const text =
      format === "csv" ? tableDataToCSV(data) : format === "tsv" ? tableDataToTSV(data) : tableDataToMarkdown(data);
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 2_000);
  }, []);

  const downloadTable = useCallback(() => {
    const el = tableRef.current;
    if (!el) return;
    const data = extractTableDataFromElement(el);
    const md = tableDataToMarkdown(data);
    const url = URL.createObjectURL(new Blob([md], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "table.md";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, []);

  return (
    <section className="markdown-table-block" data-streamdown="table-block">
      <header className="markdown-table-header" data-streamdown="table-header">
        <span className="markdown-table-label">
          <Table size={14} aria-hidden="true" />
          表格
        </span>
        <div className="markdown-table-actions" data-streamdown="table-actions">
          <TooltipIconButton
            className="markdown-table-action"
            tooltip="全屏查看"
            side="top"
            onClick={() => setFullscreenOpen(true)}
          >
            <Maximize aria-hidden="true" />
          </TooltipIconButton>
          <TooltipIconButton
            className="markdown-table-action"
            tooltip={copied ? "已复制" : "复制为 Markdown"}
            side="top"
            onClick={() => void copyTable("md").catch(() => undefined)}
          >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </TooltipIconButton>
          <TooltipIconButton className="markdown-table-action" tooltip="下载表格" side="top" onClick={downloadTable}>
            <Download aria-hidden="true" />
          </TooltipIconButton>
        </div>
      </header>
      <div className="markdown-table-scroll" data-streamdown="table-body">
        <table ref={tableRef} className="markdown-table" style={style} {...props}>
          {children}
        </table>
      </div>

      <Dialog open={fullscreenOpen} onOpenChange={setFullscreenOpen}>
        <DialogContent className="max-h-[90dvh] max-w-[90vw] overflow-hidden p-4 sm:max-w-[90vw]">
          <DialogTitle className="sr-only">表格全屏预览</DialogTitle>
          <div className="markdown-table-fullscreen-scroll">
            <table className="markdown-table markdown-table-fullscreen" style={style} {...props}>
              {children}
            </table>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
