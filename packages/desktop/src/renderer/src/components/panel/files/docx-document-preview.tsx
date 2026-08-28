import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import AlignCenter from "lucide-react/dist/esm/icons/align-center.mjs";
import AlignJustify from "lucide-react/dist/esm/icons/align-justify.mjs";
import AlignLeft from "lucide-react/dist/esm/icons/align-left.mjs";
import AlignRight from "lucide-react/dist/esm/icons/align-right.mjs";
import Bold from "lucide-react/dist/esm/icons/bold.mjs";
import Clipboard from "lucide-react/dist/esm/icons/clipboard.mjs";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import Italic from "lucide-react/dist/esm/icons/italic.mjs";
import List from "lucide-react/dist/esm/icons/list.mjs";
import ListOrdered from "lucide-react/dist/esm/icons/list-ordered.mjs";
import Redo2 from "lucide-react/dist/esm/icons/redo-2.mjs";
import Save from "lucide-react/dist/esm/icons/save.mjs";
import Scissors from "lucide-react/dist/esm/icons/scissors.mjs";
import Strikethrough from "lucide-react/dist/esm/icons/strikethrough.mjs";
import AlertTriangle from "lucide-react/dist/esm/icons/triangle-alert.mjs";
import Underline from "lucide-react/dist/esm/icons/underline.mjs";
import Undo2 from "lucide-react/dist/esm/icons/undo-2.mjs";
import ZoomIn from "lucide-react/dist/esm/icons/zoom-in.mjs";
import ZoomOut from "lucide-react/dist/esm/icons/zoom-out.mjs";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DocxDocumentPreview,
  DocxEditorSource,
  OfficeDocumentPlan,
} from "../../../../../shared/office-document-contracts.ts";
import { errorMessage } from "../../../shared/lib/error-message.ts";
import { Button } from "../../../shared/ui/button.tsx";
import { Dialog } from "../../../shared/ui/dialog.tsx";
import { DialogContent } from "../../../shared/ui/dialog-content.tsx";
import { DialogFooter } from "../../../shared/ui/dialog-footer.tsx";
import { DialogTitle } from "../../../shared/ui/dialog-title.tsx";
import { parseDocx } from "../../../vendor/genoffice-docx-engine/parse.ts";
import { type ParsedDocFull, saveDocx } from "../../../vendor/genoffice-docx-engine/patch.ts";
import { docxEditorExtensions } from "./docx-editor-extensions.ts";
import { docxToEditorContent, editorContentToSaveBlocks, firstListId } from "./docx-editor-model.ts";
import { classifyIncomingDocxPlan, confirmDocxPlan, discardDocxPlan } from "./docx-plan-actions.ts";
import { DocxPlanDiff } from "./docx-plan-diff.tsx";

const FONT_FAMILIES = ["Calibri", "Arial", "Times New Roman", "Microsoft YaHei", "SimSun"];
const FONT_SIZES = [9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 36];
const RIBBON_TABS = ["开始", "插入", "布局", "视图"] as const;
type RibbonTab = (typeof RIBBON_TABS)[number];

interface LoadedDocument {
  source: DocxEditorSource;
  parsed: ParsedDocFull;
}

export function DocxDocumentPreviewView({
  preview,
  onCommitted,
}: {
  preview: DocxDocumentPreview;
  onCommitted?(preview: DocxDocumentPreview): void;
}) {
  const { documentId, revision, warnings } = preview.renderTree;
  const [loaded, setLoaded] = useState<LoadedDocument | null>(null);
  const [tab, setTab] = useState<RibbonTab>("开始");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<OfficeDocumentPlan | null>(null);
  const [zoom, setZoom] = useState(100);
  const [, refreshToolbar] = useState(0);
  const loadingRevisionRef = useRef(0);
  const suppressDirtyRef = useRef(false);

  const editor = useEditor({
    extensions: docxEditorExtensions,
    content: { type: "doc", content: [{ type: "paragraph" }] },
    editorProps: {
      attributes: {
        class: "docx-editor-page",
        spellcheck: "true",
      },
    },
    onUpdate: () => {
      if (!suppressDirtyRef.current) setDirty(true);
      refreshToolbar((value) => value + 1);
    },
    onSelectionUpdate: () => refreshToolbar((value) => value + 1),
  });

  const loadEditorSource = useCallback(
    async (expectedDocumentId: string, expectedRevision: number) => {
      if (!editor) return;
      const loadRevision = ++loadingRevisionRef.current;
      setBusy(true);
      setError(null);
      try {
        const source = await window.desktop.files.getDocxEditorSource(expectedDocumentId);
        const parsed = await parseDocx(source.bytes);
        if (
          loadRevision !== loadingRevisionRef.current ||
          source.documentId !== expectedDocumentId ||
          source.revision !== expectedRevision
        ) {
          return;
        }
        suppressDirtyRef.current = true;
        editor.commands.setContent(docxToEditorContent(parsed), { emitUpdate: false });
        setLoaded({ source, parsed });
        setDirty(false);
        window.setTimeout(() => {
          suppressDirtyRef.current = false;
        }, 0);
      } catch (value) {
        if (loadRevision === loadingRevisionRef.current) setError(errorMessage(value));
      } finally {
        if (loadRevision === loadingRevisionRef.current) setBusy(false);
      }
    },
    [editor],
  );

  useEffect(() => {
    void loadEditorSource(documentId, revision);
  }, [documentId, revision, loadEditorSource]);

  useEffect(
    () =>
      window.desktop.files.onOfficeDocumentPlanCreated((createdPlan) => {
        const action = classifyIncomingDocxPlan(documentId, dirty, createdPlan);
        if (action === "ignore") return;
        if (action === "discard") {
          setError("请先保存或撤销当前本地编辑，再应用 Agent 修改");
          void discardDocxPlan(window.desktop.files, documentId, createdPlan).catch((value: unknown) =>
            setError(errorMessage(value)),
          );
          return;
        }
        setError(null);
        setPlan(createdPlan);
      }),
    [dirty, documentId],
  );

  const save = useCallback(async () => {
    if (!editor || !loaded || !dirty || busy) return;
    setBusy(true);
    setError(null);
    try {
      const output = await saveDocx(loaded.parsed, editorContentToSaveBlocks(editor.getJSON(), loaded.parsed), {
        savedAt: new Date().toISOString(),
      });
      const result = await window.desktop.files.saveDocxEditor({
        documentId: loaded.source.documentId,
        revision: loaded.source.revision,
        sourceSha256: loaded.source.sourceSha256,
        bytes: output,
      });
      setDirty(false);
      onCommitted?.(result.preview);
      await loadEditorSource(result.preview.renderTree.documentId, result.preview.renderTree.revision);
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  }, [busy, dirty, editor, loadEditorSource, loaded, onCommitted]);

  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const commitPlan = async () => {
    if (!plan || dirty) return;
    setBusy(true);
    setError(null);
    try {
      const committedPreview = await confirmDocxPlan(window.desktop.files, documentId, plan);
      setPlan(null);
      onCommitted?.(committedPreview);
    } catch (value) {
      setPlan(null);
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  };

  const discardPlan = async () => {
    if (!plan) return;
    const discarded = plan;
    setPlan(null);
    try {
      await discardDocxPlan(window.desktop.files, documentId, discarded);
    } catch (value) {
      setError(errorMessage(value));
    }
  };

  const wordCount = editor?.state.doc.textContent.trim().split(/\s+/u).filter(Boolean).length ?? 0;
  const fileName = preview.path.split(/[\\/]/u).at(-1) ?? preview.path;

  return (
    <div className="docx-editor" aria-busy={busy}>
      <header className="docx-editor-ribbon">
        <div className="docx-ribbon-tabs">
          <button
            type="button"
            className="docx-ribbon-file"
            disabled={busy || !dirty}
            title="保存"
            onClick={() => void save()}
          >
            <Save size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="docx-ribbon-quick"
            disabled={!editor?.can().undo()}
            title="撤销"
            onClick={() => editor?.chain().focus().undo().run()}
          >
            <Undo2 size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="docx-ribbon-quick"
            disabled={!editor?.can().redo()}
            title="重做"
            onClick={() => editor?.chain().focus().redo().run()}
          >
            <Redo2 size={16} aria-hidden="true" />
          </button>
          <span className="docx-ribbon-document" title={preview.path}>
            {fileName}
            {dirty ? <span aria-label="未保存">*</span> : null}
          </span>
          {RIBBON_TABS.map((item) => (
            <button
              type="button"
              className="docx-ribbon-tab"
              data-active={tab === item ? "" : undefined}
              key={item}
              onClick={() => setTab(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <RibbonBody tab={tab} editor={editor} loaded={loaded} zoom={zoom} setZoom={setZoom} reportError={setError} />
      </header>

      <main className="docx-editor-workspace">
        {warnings.length > 0 ? (
          <div className="docx-warning" role="status">
            <AlertTriangle size={15} aria-hidden="true" />
            <span>{warnings.map((warning) => warning.message).join("; ")}</span>
          </div>
        ) : null}
        {error ? (
          <p className="panel-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="docx-editor-page-wrap" style={{ zoom: zoom / 100 }}>
          {editor ? <EditorContent editor={editor} /> : null}
        </div>
      </main>

      <footer className="docx-editor-status">
        <span>第 1 页，共 1 页</span>
        <span>{wordCount} 个字词</span>
        <span className="docx-editor-save-state">{busy ? "正在处理" : dirty ? "未保存" : "已保存"}</span>
        <button type="button" title="缩小" onClick={() => setZoom((value) => clampZoom(value - 10))}>
          <ZoomOut size={14} aria-hidden="true" />
        </button>
        <input
          type="range"
          min="50"
          max="180"
          step="10"
          value={zoom}
          aria-label="缩放"
          onChange={(event) => setZoom(Number(event.target.value))}
        />
        <button type="button" title="放大" onClick={() => setZoom((value) => clampZoom(value + 10))}>
          <ZoomIn size={14} aria-hidden="true" />
        </button>
        <span>{zoom}%</span>
      </footer>

      <Dialog
        open={plan !== null}
        onOpenChange={(open) => {
          if (!open && !busy) void discardPlan();
        }}
      >
        {plan ? (
          <DialogContent className="docx-plan-dialog">
            <DialogTitle id="docx-plan-title">确认 Agent 文档修改</DialogTitle>
            <DocxPlanDiff plan={plan} />
            <p className="docx-plan-parts">触达部件：{plan.touchedParts.join(", ")}</p>
            <DialogFooter className="docx-plan-footer" variant="actions">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void discardPlan()}>
                取消
              </Button>
              <Button size="sm" disabled={busy || dirty} onClick={() => void commitPlan()}>
                确认保存
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}

function RibbonBody({
  tab,
  editor,
  loaded,
  zoom,
  setZoom,
  reportError,
}: {
  tab: RibbonTab;
  editor: Editor | null;
  loaded: LoadedDocument | null;
  zoom: number;
  setZoom(value: number): void;
  reportError(message: string): void;
}) {
  if (!editor) return <div className="docx-ribbon-body" />;
  if (tab === "开始") return <HomeRibbon editor={editor} loaded={loaded} reportError={reportError} />;
  if (tab === "布局") return <LayoutRibbon editor={editor} />;
  if (tab === "视图") {
    return (
      <div className="docx-ribbon-body">
        <RibbonGroup label="缩放">
          <RibbonIcon title="缩小" onClick={() => setZoom(clampZoom(zoom - 10))}>
            <ZoomOut size={18} />
          </RibbonIcon>
          <button type="button" className="docx-ribbon-command" onClick={() => setZoom(100)}>
            100%
          </button>
          <RibbonIcon title="放大" onClick={() => setZoom(clampZoom(zoom + 10))}>
            <ZoomIn size={18} />
          </RibbonIcon>
        </RibbonGroup>
      </div>
    );
  }
  return (
    <div className="docx-ribbon-body">
      <RibbonGroup label="插入">
        <button
          type="button"
          className="docx-ribbon-command"
          onClick={() => editor.chain().focus().insertContent(new Date().toLocaleDateString()).run()}
        >
          日期
        </button>
        <button
          type="button"
          className="docx-ribbon-command"
          onClick={() => editor.chain().focus().insertContent("—").run()}
        >
          符号
        </button>
      </RibbonGroup>
    </div>
  );
}

function HomeRibbon({
  editor,
  loaded,
  reportError,
}: {
  editor: Editor;
  loaded: LoadedDocument | null;
  reportError(message: string): void;
}) {
  const format = editor.getAttributes("docFormat");
  const paragraph = editor.getAttributes("paragraph");
  const paragraphFormat = isRecord(paragraph.format) ? paragraph.format : {};
  const font =
    typeof format.font === "string" ? format.font : typeof format.fontAscii === "string" ? format.fontAscii : "Calibri";
  const size = typeof format.sizeHalfPoints === "number" ? format.sizeHalfPoints / 2 : 11;
  const currentColor = typeof format.color === "string" ? `#${format.color}` : "#000000";
  const bulletId = loaded ? firstListId(loaded.parsed, "bullet") : null;
  const orderedId = loaded ? firstListId(loaded.parsed, "ordered") : null;

  const setFormat = (patch: Record<string, unknown>) => {
    editor
      .chain()
      .focus()
      .setMark("docFormat", { ...format, ...patch })
      .run();
  };
  const setAlignment = (align: "left" | "center" | "right" | "justify") => {
    const current = isRecord(paragraph.format) ? paragraph.format : {};
    editor
      .chain()
      .focus()
      .updateAttributes("paragraph", { format: { ...current, align } })
      .run();
  };
  const setBlockStyle = (blockType: "paragraph" | "heading", level: number | null) => {
    editor
      .chain()
      .focus()
      .updateAttributes("paragraph", {
        blockType,
        level,
        styleId: null,
        listKind: null,
        numId: null,
        ilvl: null,
      })
      .run();
  };
  const setList = (kind: "bullet" | "ordered", numId: string | null) => {
    if (!numId) return;
    const active = paragraph.blockType === "listItem" && paragraph.listKind === kind;
    editor
      .chain()
      .focus()
      .updateAttributes("paragraph", {
        blockType: active ? "paragraph" : "listItem",
        listKind: active ? null : kind,
        numId: active ? null : numId,
        ilvl: active ? null : 0,
        level: null,
      })
      .run();
  };

  return (
    <div className="docx-ribbon-body">
      <RibbonGroup label="剪贴板">
        <RibbonIcon
          title="粘贴"
          onClick={() => {
            void navigator.clipboard
              .readText()
              .then((text) => editor.chain().focus().insertContent(text).run())
              .catch((value: unknown) => reportError(errorMessage(value)));
          }}
        >
          <Clipboard size={20} />
        </RibbonIcon>
        <RibbonIcon title="剪切" onClick={() => document.execCommand("cut")}>
          <Scissors size={16} />
        </RibbonIcon>
        <RibbonIcon title="复制" onClick={() => document.execCommand("copy")}>
          <Copy size={16} />
        </RibbonIcon>
      </RibbonGroup>
      <RibbonGroup label="字体">
        <div className="docx-ribbon-row">
          <select
            value={font}
            aria-label="字体"
            onChange={(event) => setFormat({ font: event.target.value, fontAscii: event.target.value })}
          >
            {FONT_FAMILIES.map((family) => (
              <option value={family} key={family}>
                {family}
              </option>
            ))}
          </select>
          <select
            value={size}
            aria-label="字号"
            onChange={(event) => setFormat({ sizeHalfPoints: Number(event.target.value) * 2 })}
          >
            {FONT_SIZES.map((fontSize) => (
              <option value={fontSize} key={fontSize}>
                {fontSize}
              </option>
            ))}
          </select>
        </div>
        <div className="docx-ribbon-row">
          <RibbonIcon
            active={editor.isActive("bold")}
            title="加粗"
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <Bold size={16} />
          </RibbonIcon>
          <RibbonIcon
            active={editor.isActive("italic")}
            title="斜体"
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <Italic size={16} />
          </RibbonIcon>
          <RibbonIcon
            active={editor.isActive("underline")}
            title="下划线"
            onClick={() => editor.chain().focus().toggleUnderline().run()}
          >
            <Underline size={16} />
          </RibbonIcon>
          <RibbonIcon
            active={editor.isActive("strike")}
            title="删除线"
            onClick={() => editor.chain().focus().toggleStrike().run()}
          >
            <Strikethrough size={16} />
          </RibbonIcon>
          <label className="docx-ribbon-color" title="字体颜色">
            <span style={{ background: currentColor }} />
            <input
              type="color"
              value={currentColor}
              aria-label="字体颜色"
              onChange={(event) => setFormat({ color: event.target.value.slice(1).toUpperCase() })}
            />
          </label>
        </div>
      </RibbonGroup>
      <RibbonGroup label="段落">
        <div className="docx-ribbon-row">
          <RibbonIcon active={paragraphFormat.align === "left"} title="左对齐" onClick={() => setAlignment("left")}>
            <AlignLeft size={16} />
          </RibbonIcon>
          <RibbonIcon active={paragraphFormat.align === "center"} title="居中" onClick={() => setAlignment("center")}>
            <AlignCenter size={16} />
          </RibbonIcon>
          <RibbonIcon active={paragraphFormat.align === "right"} title="右对齐" onClick={() => setAlignment("right")}>
            <AlignRight size={16} />
          </RibbonIcon>
          <RibbonIcon
            active={paragraphFormat.align === "justify"}
            title="两端对齐"
            onClick={() => setAlignment("justify")}
          >
            <AlignJustify size={16} />
          </RibbonIcon>
        </div>
        <div className="docx-ribbon-row">
          <RibbonIcon
            active={paragraph.listKind === "bullet"}
            disabled={!bulletId}
            title="项目符号"
            onClick={() => setList("bullet", bulletId)}
          >
            <List size={16} />
          </RibbonIcon>
          <RibbonIcon
            active={paragraph.listKind === "ordered"}
            disabled={!orderedId}
            title="编号"
            onClick={() => setList("ordered", orderedId)}
          >
            <ListOrdered size={16} />
          </RibbonIcon>
        </div>
      </RibbonGroup>
      <RibbonGroup label="样式">
        <button
          type="button"
          className="docx-style-card"
          data-active={paragraph.blockType === "paragraph" ? "" : undefined}
          onClick={() => setBlockStyle("paragraph", null)}
        >
          <strong>正文</strong>
          <span>Normal</span>
        </button>
        {[1, 2, 3].map((level) => (
          <button
            type="button"
            className="docx-style-card"
            data-active={paragraph.blockType === "heading" && paragraph.level === level ? "" : undefined}
            key={level}
            onClick={() => setBlockStyle("heading", level)}
          >
            <strong>标题 {level}</strong>
            <span>Heading {level}</span>
          </button>
        ))}
      </RibbonGroup>
    </div>
  );
}

function LayoutRibbon({ editor }: { editor: Editor }) {
  const paragraph = editor.getAttributes("paragraph");
  const format = isRecord(paragraph.format) ? paragraph.format : {};
  const setSpacing = (key: "spaceBefore" | "spaceAfter", value: number) => {
    editor
      .chain()
      .focus()
      .updateAttributes("paragraph", { format: { ...format, [key]: value } })
      .run();
  };
  return (
    <div className="docx-ribbon-body">
      <RibbonGroup label="段落间距">
        <label className="docx-ribbon-field">
          段前
          <input
            type="number"
            min="0"
            value={typeof format.spaceBefore === "number" ? format.spaceBefore : 0}
            onChange={(event) => setSpacing("spaceBefore", Number(event.target.value))}
          />
        </label>
        <label className="docx-ribbon-field">
          段后
          <input
            type="number"
            min="0"
            value={typeof format.spaceAfter === "number" ? format.spaceAfter : 0}
            onChange={(event) => setSpacing("spaceAfter", Number(event.target.value))}
          />
        </label>
      </RibbonGroup>
    </div>
  );
}

function RibbonGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="docx-ribbon-group">
      <div className="docx-ribbon-group-content">{children}</div>
      <span>{label}</span>
    </section>
  );
}

function RibbonIcon({
  title,
  active = false,
  disabled = false,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="docx-ribbon-icon"
      data-active={active ? "" : undefined}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function clampZoom(value: number): number {
  return Math.min(180, Math.max(50, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
