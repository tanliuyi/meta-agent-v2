import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useRef } from "react";
import { MemoryEntryToolbar } from "./memory-entry-toolbar.tsx";

const MEMORY_ENTRY_EXTENSIONS = [
  StarterKit.configure({ link: false }),
  Link.configure({ autolink: true, defaultProtocol: "https", openOnClick: false }),
  Placeholder.configure({ placeholder: "输入记忆内容" }),
  Markdown,
];

const MEMORY_ENTRY_EDITOR_PROPS = {
  attributes: {
    "aria-label": "记忆内容",
  },
};

interface MemoryEntryEditorProps {
  initialContent: string;
  onChange(content: string): void;
}

/** Tiptap editor that reads and writes the Markdown-backed memory content. */
export function MemoryEntryEditor({ initialContent, onChange }: MemoryEntryEditorProps) {
  const initialContentRef = useRef(initialContent);
  const editor = useEditor({
    extensions: MEMORY_ENTRY_EXTENSIONS,
    content: initialContentRef.current,
    contentType: "markdown",
    editorProps: MEMORY_ENTRY_EDITOR_PROPS,
    shouldRerenderOnTransaction: false,
    onUpdate: ({ editor: updatedEditor }) => onChange(updatedEditor.getMarkdown()),
  });

  return (
    <div className="memory-entry-editor">
      <MemoryEntryToolbar editor={editor} />
      <div className="memory-entry-editor-surface">
        <EditorContent editor={editor} className="memory-entry-editor-input" />
      </div>
    </div>
  );
}
