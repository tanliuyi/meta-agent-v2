import { Mark, mergeAttributes, Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

export const docxEditorExtensions = [
  StarterKit.configure({
    blockquote: false,
    bulletList: false,
    code: false,
    codeBlock: false,
    heading: false,
    listItem: false,
    orderedList: false,
    paragraph: false,
  }),
  Node.create({
    name: "paragraph",
    group: "block",
    content: "inline*",
    defining: true,
    addAttributes() {
      return {
        docxIndex: { default: null },
        blockType: { default: "paragraph" },
        level: { default: null },
        styleId: { default: null },
        listKind: { default: null },
        numId: { default: null },
        ilvl: { default: null },
        format: { default: null },
      };
    },
    parseHTML() {
      return [{ tag: "p" }];
    },
    renderHTML({ node, HTMLAttributes }) {
      const format = isRecord(node.attrs.format) ? node.attrs.format : {};
      const style = paragraphStyle(format);
      return [
        "p",
        mergeAttributes(HTMLAttributes, {
          "data-block-type": node.attrs.blockType,
          "data-heading-level": node.attrs.level,
          "data-list-kind": node.attrs.listKind,
          "data-list-level": node.attrs.ilvl,
          style,
        }),
        0,
      ];
    },
    addKeyboardShortcuts() {
      return {
        Enter: () =>
          this.editor
            .chain()
            .splitBlock()
            .updateAttributes("paragraph", {
              docxIndex: null,
              blockType: "paragraph",
              level: null,
              styleId: null,
              listKind: null,
              numId: null,
              ilvl: null,
              format: null,
            })
            .run(),
      };
    },
  }),
  Node.create({
    name: "protectedBlock",
    group: "block",
    atom: true,
    selectable: true,
    addAttributes() {
      return {
        docxIndex: { default: null },
        label: { default: "受保护的文档内容" },
        previewText: { default: "" },
        imageDataUrl: { default: null },
      };
    },
    parseHTML() {
      return [{ tag: "div[data-docx-protected]" }];
    },
    renderHTML({ node, HTMLAttributes }) {
      const imageDataUrl = typeof node.attrs.imageDataUrl === "string" ? node.attrs.imageDataUrl : null;
      const previewText = typeof node.attrs.previewText === "string" ? node.attrs.previewText : "";
      const label = typeof node.attrs.label === "string" ? node.attrs.label : "受保护的文档内容";
      return [
        "div",
        mergeAttributes(HTMLAttributes, {
          "data-docx-protected": "",
          contenteditable: "false",
        }),
        ...(imageDataUrl
          ? [["img", { src: imageDataUrl, alt: label }]]
          : [["span", { class: "docx-protected-label" }, label]]),
        ...(previewText ? [["span", { class: "docx-protected-preview" }, previewText]] : []),
      ];
    },
  }),
  Mark.create({
    name: "docRun",
    inclusive: true,
    addAttributes() {
      return {
        runIndex: { default: null },
        source: { default: null },
      };
    },
    parseHTML() {
      return [{ tag: "span[data-docx-run]" }];
    },
    renderHTML({ HTMLAttributes }) {
      return ["span", { "data-docx-run": HTMLAttributes.runIndex ?? "" }, 0];
    },
  }),
  Mark.create({
    name: "docFormat",
    inclusive: true,
    addAttributes() {
      return {
        color: { default: null },
        font: { default: null },
        fontAscii: { default: null },
        sizeHalfPoints: { default: null },
        highlight: { default: null },
      };
    },
    parseHTML() {
      return [{ tag: "span[data-docx-format]" }];
    },
    renderHTML({ HTMLAttributes }) {
      const color = typeof HTMLAttributes.color === "string" ? `#${HTMLAttributes.color}` : undefined;
      const font =
        typeof HTMLAttributes.font === "string"
          ? HTMLAttributes.font
          : typeof HTMLAttributes.fontAscii === "string"
            ? HTMLAttributes.fontAscii
            : undefined;
      const size =
        typeof HTMLAttributes.sizeHalfPoints === "number" ? `${HTMLAttributes.sizeHalfPoints / 2}pt` : undefined;
      const highlight = typeof HTMLAttributes.highlight === "string" ? HTMLAttributes.highlight : undefined;
      return [
        "span",
        {
          "data-docx-format": "",
          style: [
            color ? `color:${color}` : "",
            font ? `font-family:${JSON.stringify(font)}` : "",
            size ? `font-size:${size}` : "",
            highlight ? `background-color:${highlight}` : "",
          ]
            .filter(Boolean)
            .join(";"),
        },
        0,
      ];
    },
  }),
];

function paragraphStyle(format: Record<string, unknown>): string {
  const declarations: string[] = [];
  if (typeof format.align === "string") declarations.push(`text-align:${format.align}`);
  if (typeof format.indentLeft === "number") declarations.push(`margin-left:${format.indentLeft / 15}px`);
  if (typeof format.indentRight === "number") declarations.push(`margin-right:${format.indentRight / 15}px`);
  if (typeof format.indentFirstLine === "number") {
    declarations.push(`text-indent:${format.indentFirstLine / 15}px`);
  }
  if (typeof format.spaceBefore === "number") declarations.push(`margin-top:${format.spaceBefore / 15}px`);
  if (typeof format.spaceAfter === "number") declarations.push(`margin-bottom:${format.spaceAfter / 15}px`);
  if (typeof format.lineSpacing === "number") declarations.push(`line-height:${format.lineSpacing}`);
  return declarations.join(";");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
