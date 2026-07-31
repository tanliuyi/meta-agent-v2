import { TooltipIconButton } from "@renderer/components/assistant-ui/tooltip-icon-button";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import Bold from "lucide-react/dist/esm/icons/bold.mjs";
import Heading2 from "lucide-react/dist/esm/icons/heading-2.mjs";
import Italic from "lucide-react/dist/esm/icons/italic.mjs";
import Link from "lucide-react/dist/esm/icons/link.mjs";
import List from "lucide-react/dist/esm/icons/list.mjs";
import ListOrdered from "lucide-react/dist/esm/icons/list-ordered.mjs";
import Quote from "lucide-react/dist/esm/icons/quote.mjs";
import Redo2 from "lucide-react/dist/esm/icons/redo-2.mjs";
import Undo2 from "lucide-react/dist/esm/icons/undo-2.mjs";

interface MemoryEntryToolbarProps {
  editor: Editor | null;
}

interface MemoryEntryToolbarState {
  canRedo: boolean;
  canUndo: boolean;
  isBlockquote: boolean;
  isBold: boolean;
  isBulletList: boolean;
  isHeading: boolean;
  isItalic: boolean;
  isLink: boolean;
  isOrderedList: boolean;
}

const EMPTY_TOOLBAR_STATE: MemoryEntryToolbarState = {
  canRedo: false,
  canUndo: false,
  isBlockquote: false,
  isBold: false,
  isBulletList: false,
  isHeading: false,
  isItalic: false,
  isLink: false,
  isOrderedList: false,
};

interface MemoryEntryToolbarEditor {
  can(): {
    redo(): boolean;
    undo(): boolean;
  };
  isActive(name: string, attributes?: Record<string, unknown>): boolean;
}

export function getMemoryEntryToolbarState(editor: MemoryEntryToolbarEditor | null): MemoryEntryToolbarState {
  if (!editor) return EMPTY_TOOLBAR_STATE;
  return {
    canRedo: editor.can().redo(),
    canUndo: editor.can().undo(),
    isBlockquote: editor.isActive("blockquote"),
    isBold: editor.isActive("bold"),
    isBulletList: editor.isActive("bulletList"),
    isHeading: editor.isActive("heading", { level: 2 }),
    isItalic: editor.isActive("italic"),
    isLink: editor.isActive("link"),
    isOrderedList: editor.isActive("orderedList"),
  };
}

export function MemoryEntryToolbar({ editor }: MemoryEntryToolbarProps) {
  const state = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => getMemoryEntryToolbarState(currentEditor),
  });
  const toolbarState = state ?? EMPTY_TOOLBAR_STATE;

  function addLink(): void {
    if (!editor) return;
    const url = window.prompt("链接地址", "https://")?.trim();
    if (url) editor.chain().focus().setLink({ href: url }).run();
  }

  return (
    <div className="memory-entry-toolbar" role="toolbar" aria-label="记忆内容格式">
      <TooltipIconButton
        tooltip="撤销"
        disabled={!toolbarState.canUndo}
        onClick={() => editor?.chain().focus().undo().run()}
      >
        <Undo2 />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip="重做"
        disabled={!toolbarState.canRedo}
        onClick={() => editor?.chain().focus().redo().run()}
      >
        <Redo2 />
      </TooltipIconButton>
      <span className="memory-entry-toolbar-divider" aria-hidden="true" />
      <TooltipIconButton
        tooltip="二级标题"
        aria-pressed={toolbarState.isHeading}
        onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        <Heading2 />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip="加粗"
        aria-pressed={toolbarState.isBold}
        onClick={() => editor?.chain().focus().toggleBold().run()}
      >
        <Bold />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip="斜体"
        aria-pressed={toolbarState.isItalic}
        onClick={() => editor?.chain().focus().toggleItalic().run()}
      >
        <Italic />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip="无序列表"
        aria-pressed={toolbarState.isBulletList}
        onClick={() => editor?.chain().focus().toggleBulletList().run()}
      >
        <List />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip="有序列表"
        aria-pressed={toolbarState.isOrderedList}
        onClick={() => editor?.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip="引用"
        aria-pressed={toolbarState.isBlockquote}
        onClick={() => editor?.chain().focus().toggleBlockquote().run()}
      >
        <Quote />
      </TooltipIconButton>
      <TooltipIconButton tooltip="链接" aria-pressed={toolbarState.isLink} onClick={addLink}>
        <Link />
      </TooltipIconButton>
    </div>
  );
}
