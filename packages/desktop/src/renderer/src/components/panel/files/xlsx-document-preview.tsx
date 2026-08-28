import { useVirtualizer } from "@tanstack/react-virtual";
import AlertTriangle from "lucide-react/dist/esm/icons/triangle-alert.mjs";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  OfficeDocumentPlan,
  XlsxCell,
  XlsxDocumentPreview,
} from "../../../../../shared/office-document-contracts.ts";
import { errorMessage } from "../../../shared/lib/error-message.ts";
import { Button } from "../../../shared/ui/button.tsx";
import { Dialog } from "../../../shared/ui/dialog.tsx";
import { DialogContent } from "../../../shared/ui/dialog-content.tsx";
import { DialogFooter } from "../../../shared/ui/dialog-footer.tsx";
import { DialogTitle } from "../../../shared/ui/dialog-title.tsx";
import { DocxPlanDiff } from "./docx-plan-diff.tsx";

const MAX_RENDER_COLUMNS = 26;
const MAX_RENDER_ROWS = 10_000;

interface SheetViewState {
  readonly previewKey: string;
  readonly sheetId: string;
  readonly cells: XlsxCell[];
}

export function XlsxDocumentPreviewView({
  preview,
  onCommitted,
}: {
  preview: XlsxDocumentPreview;
  onCommitted?(preview: XlsxDocumentPreview): void;
}) {
  const previewKey = `${preview.documentId}:${preview.revision}`;
  const firstSheet = preview.sheets[0];
  const [sheetView, setSheetView] = useState<SheetViewState>(() => ({
    previewKey,
    sheetId: firstSheet?.id ?? "",
    cells: firstSheet?.cells ?? [],
  }));
  const [editing, setEditing] = useState<XlsxCell | null>(null);
  const [replacement, setReplacement] = useState("");
  const [plan, setPlan] = useState<OfficeDocumentPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const requestedRanges = useRef(new Map<string, number>());
  const requestGeneration = useRef(0);
  const activeSheet =
    sheetView.previewKey === previewKey ? preview.sheets.find((item) => item.id === sheetView.sheetId) : undefined;
  const sheet = activeSheet ?? firstSheet;
  const loadedCells = activeSheet ? sheetView.cells : (firstSheet?.cells ?? []);
  const cells = useMemo(() => new Map(loadedCells.map((cell) => [cell.address, cell])), [loadedCells]);
  const bounds = {
    rows: sheet?.rowCount ?? 1,
    columns: sheet?.columnCount ?? 1,
    truncated: sheet?.truncated ?? false,
  };
  const rows = useVirtualizer({
    count: bounds.rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 34,
    overscan: 12,
    initialRect: { height: 600, width: 800 },
  });

  const virtualRows = rows.getVirtualItems();
  const firstVisibleRow = (virtualRows[0]?.index ?? 0) + 1;
  const lastVisibleRow = (virtualRows.at(-1)?.index ?? Math.min(bounds.rows - 1, 15)) + 1;

  useEffect(() => {
    requestGeneration.current += 1;
    const generation = requestGeneration.current;
    const first = preview.sheets[0];
    setSheetView({ previewKey, sheetId: first?.id ?? "", cells: first?.cells ?? [] });
    requestedRanges.current.clear();
    return () => {
      if (requestGeneration.current === generation) requestGeneration.current += 1;
    };
  }, [previewKey, preview.sheets]);

  useEffect(() => {
    if (!sheet) return;
    const generation = requestGeneration.current;
    const firstChunk = Math.floor((firstVisibleRow - 1) / 16) * 16 + 1;
    const lastChunk = Math.floor((lastVisibleRow - 1) / 16) * 16 + 1;
    for (let chunkStart = firstChunk; chunkStart <= lastChunk; chunkStart += 16) {
      const chunkEnd = Math.min(sheet.rowCount, chunkStart + 15);
      const key = `${preview.revision}:${sheet.id}:${chunkStart}:${chunkEnd}`;
      if (requestedRanges.current.has(key)) continue;
      requestedRanges.current.set(key, generation);
      void window.desktop.files
        .inspectOfficeDocument({
          documentId: preview.documentId,
          query: {
            mode: "cells",
            sheetId: sheet.id,
            range: `A${chunkStart}:${columnName(sheet.columnCount)}${chunkEnd}`,
            limit: 500,
          },
        })
        .then((inspection) => {
          if (requestGeneration.current !== generation) {
            if (requestedRanges.current.get(key) === generation) requestedRanges.current.delete(key);
            return;
          }
          if (inspection.documentId !== preview.documentId || inspection.revision !== preview.revision) {
            if (requestedRanges.current.get(key) === generation) requestedRanges.current.delete(key);
            setError("XLSX 文档版本已更新，请重新打开预览");
            return;
          }
          if (inspection.mode !== "cells") return;
          setSheetView((current) => {
            if (current.previewKey !== previewKey || current.sheetId !== sheet.id) return current;
            const merged = new Map(current.cells.map((cell) => [cell.id, cell]));
            for (const cell of inspection.cells) merged.set(cell.id, cell);
            return { ...current, cells: [...merged.values()] };
          });
        })
        .catch((value: unknown) => {
          if (requestedRanges.current.get(key) === generation) requestedRanges.current.delete(key);
          if (requestGeneration.current === generation) setError(errorMessage(value));
        });
    }
  }, [firstVisibleRow, lastVisibleRow, preview.documentId, preview.revision, previewKey, sheet]);

  useEffect(
    () =>
      window.desktop.files.onOfficeDocumentPlanCreated((created) => {
        if (created.documentId !== preview.documentId) return;
        setEditing(null);
        setPlan(created);
      }),
    [preview.documentId],
  );

  const requestPlan = async () => {
    if (!editing || replacement === editing.value) {
      setEditing(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setPlan(
        await window.desktop.files.planOfficeDocument({
          documentId: preview.documentId,
          envelope: {
            protocolVersion: 1,
            operations: [
              {
                type: "set_cell_value",
                target: { sheetId: sheet!.id, cellId: editing.id, address: editing.address },
                precondition: {
                  documentRevision: preview.revision,
                  expectedValue: editing.value,
                  expectedValueSha256: editing.valueSha256,
                },
                replacement,
              },
            ],
          },
        }),
      );
      setEditing(null);
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    if (!plan) return;
    const discarded = plan;
    setPlan(null);
    try {
      await window.desktop.files.discardOfficeDocumentPlan({
        documentId: preview.documentId,
        planId: discarded.planId,
      });
    } catch (value) {
      setError(errorMessage(value));
    }
  };
  const commit = async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.desktop.files.commitOfficeDocument({
        documentId: preview.documentId,
        planId: plan.planId,
        planSha256: plan.planSha256,
      });
      if (result.preview.kind !== "xlsx") throw new Error("XLSX 保存结果格式无效");
      setPlan(null);
      onCommitted?.(result.preview);
    } catch (value) {
      setPlan(null);
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  };

  if (!sheet) return <p className="panel-error">工作簿没有可显示的 worksheet</p>;
  return (
    <div className="xlsx-preview" aria-busy={busy}>
      {bounds.truncated ? (
        <div className="xlsx-warning" role="status">
          <AlertTriangle size={15} aria-hidden="true" />
          仅显示前 {MAX_RENDER_ROWS} 行和 {MAX_RENDER_COLUMNS} 列
        </div>
      ) : null}
      {error ? (
        <p className="panel-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="xlsx-sheet-tabs" role="tablist" aria-label="工作表">
        {preview.sheets.map((item) => (
          <button
            type="button"
            role="tab"
            aria-selected={item.id === sheet.id}
            key={item.id}
            onClick={() => {
              requestGeneration.current += 1;
              setSheetView({ previewKey, sheetId: item.id, cells: item.cells });
              requestedRanges.current.clear();
              setEditing(null);
            }}
          >
            {item.name}
          </button>
        ))}
      </div>
      <div
        className="xlsx-grid"
        ref={scrollRef}
        role="grid"
        aria-label={`${sheet.name} 单元格`}
        aria-rowcount={bounds.rows + 1}
        aria-colcount={bounds.columns + 1}
      >
        <div
          className="xlsx-grid-row xlsx-grid-header"
          role="row"
          style={{ gridTemplateColumns: `48px repeat(${bounds.columns}, 140px)` }}
        >
          <span role="columnheader" />
          {Array.from({ length: bounds.columns }, (_, index) => (
            <span role="columnheader" key={index}>
              {columnName(index + 1)}
            </span>
          ))}
        </div>
        <div className="xlsx-grid-rows" style={{ height: rows.getTotalSize() }}>
          {virtualRows.map((virtualRow) => {
            const row = virtualRow.index + 1;
            return (
              <div
                className="xlsx-grid-row"
                role="row"
                aria-rowindex={row + 1}
                key={row}
                style={{
                  gridTemplateColumns: `48px repeat(${bounds.columns}, 140px)`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <span className="xlsx-row-header" role="rowheader">
                  {row}
                </span>
                {Array.from({ length: bounds.columns }, (_, index) => {
                  const address = `${columnName(index + 1)}${row}`;
                  const cell = cells.get(address);
                  return cell?.editable ? (
                    <button
                      type="button"
                      className="xlsx-cell xlsx-cell-editable"
                      role="gridcell"
                      key={address}
                      title={`${address}：编辑单元格`}
                      onClick={() => {
                        setEditing(cell);
                        setReplacement(cell.value);
                      }}
                    >
                      {cell.value}
                    </button>
                  ) : (
                    <span className="xlsx-cell" role="gridcell" title={cell?.blockedReason} key={address}>
                      {cell?.value ?? ""}
                    </span>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setEditing(null);
        }}
      >
        {editing ? (
          <DialogContent>
            <DialogTitle id="xlsx-cell-title">编辑 {editing.address}</DialogTitle>
            <input
              className="xlsx-cell-input"
              value={replacement}
              autoFocus
              onChange={(event) => setReplacement(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void requestPlan();
              }}
            />
            <DialogFooter variant="actions">
              <Button variant="outline" size="sm" onClick={() => setEditing(null)}>
                取消
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void requestPlan()}>
                生成计划
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
      <Dialog
        open={plan !== null}
        onOpenChange={(open) => {
          if (!open && !busy) void discard();
        }}
      >
        {plan ? (
          <DialogContent className="docx-plan-dialog">
            <DialogTitle id="xlsx-plan-title">确认工作簿修改</DialogTitle>
            <DocxPlanDiff plan={plan} />
            <p className="docx-plan-parts">触达部件：{plan.touchedParts.join(", ")}</p>
            <DialogFooter variant="actions">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void discard()}>
                取消
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void commit()}>
                确认保存
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}

function columnName(column: number): string {
  let value = column,
    result = "";
  while (value > 0) {
    value--;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}
