import {
  type Attachment,
  type AttachmentAdapter,
  type CompleteAttachment,
  type CreateAttachment,
  type PendingAttachment,
  SimpleImageAttachmentAdapter,
} from "@assistant-ui/react";
import type { ImageInput } from "../../../shared/contracts.ts";

class PiAttachmentAdapter extends SimpleImageAttachmentAdapter {
  override accept = "*";
  private readonly getFilePath: (file: File) => string;

  constructor(getFilePath: (file: File) => string) {
    super();
    this.getFilePath = getFilePath;
  }

  override async add(state: { file: File }): Promise<PendingAttachment> {
    if (state.file.type.startsWith("image/")) {
      const attachment = await super.add(state);
      return { ...attachment, id: crypto.randomUUID() };
    }

    const path = this.getFilePath(state.file);
    if (!path) throw new Error(`无法读取附件路径: ${state.file.name}`);
    return {
      id: crypto.randomUUID(),
      type: "file",
      name: state.file.name,
      contentType: state.file.type || "application/octet-stream",
      file: state.file,
      status: { type: "requires-action", reason: "composer-send" },
      content: [
        {
          type: "file",
          filename: state.file.name,
          data: path,
          mimeType: state.file.type || "application/octet-stream",
        },
      ],
    };
  }

  override async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    if (attachment.type === "image") {
      const completed = await super.send(attachment);
      const path = attachment.file ? this.getFilePath(attachment.file) : "";
      if (!path) return completed;
      return {
        ...completed,
        content: [
          ...completed.content,
          {
            type: "file",
            filename: attachment.name,
            data: path,
            mimeType: attachment.contentType ?? "application/octet-stream",
          },
        ],
      };
    }
    if (!attachment.content?.some((part) => part.type === "file")) {
      throw new Error(`附件缺少文件路径: ${attachment.name}`);
    }
    return { ...attachment, status: { type: "complete" }, content: attachment.content };
  }
}

export function createAttachmentAdapter(
  getFilePath: (file: File) => string = (file) => window.desktop.files.getPath(file),
): AttachmentAdapter {
  return new PiAttachmentAdapter(getFilePath);
}

/** Composer 与 Pi enqueue 共用的附件适配器。 */
export const attachmentAdapter = createAttachmentAdapter();

type CompleteAttachmentFn = (attachment: PendingAttachment) => Promise<CompleteAttachment>;

export interface PiPromptAttachments {
  text: string;
  images: ImageInput[];
}

export interface PiFileContext {
  path: string;
  name: string;
}

export interface ParsedPiFileContexts {
  text: string;
  files: PiFileContext[];
}

/**
 * Pi 文件上下文协议：单行 `<file name="...">...</file>`，由 Pi 侧按消息尾部识别。
 *
 * 该行本身没有来源信息，直接落库后再解析会把用户正文末尾的同等示例误吞成附件。
 * 因此本项目附加的 file 行前面带一个版本化标记行（JSON 载荷），只有同时满足：
 * 尾部 file 行数量与标记载荷一致、标记格式合法时，才把尾部内容恢复为附件；
 * 普通用户文本中的 `<file ...>` 示例（无标记）永远原样保留。
 */
const FILE_CONTEXT_MARKER_PREFIX = "<pi-file-context-v1>";
const FILE_CONTEXT_MARKER_SUFFIX = "</pi-file-context-v1>";
const FILE_CONTEXT_LINE = /^<file name="([^"]*)">([^<]*)<\/file>$/;
const FILE_CONTEXT_MARKER_LINE = /^<pi-file-context-v1>(\{.*\})<\/pi-file-context-v1>$/;

interface FileContextEnvelope {
  files: PiFileContext[];
}

/** 完成附件，并将图片与本地文件引用转换为 Pi prompt 输入。 */
export async function toPiPromptAttachments(
  text: string,
  attachments: readonly Attachment[],
  completeAttachment: CompleteAttachmentFn = (attachment) => attachmentAdapter.send(attachment),
): Promise<PiPromptAttachments> {
  const completed = await Promise.all(
    attachments.map((attachment) =>
      isCompleteAttachment(attachment) ? Promise.resolve(attachment) : completeAttachment(attachment),
    ),
  );
  const images: ImageInput[] = [];
  const files: PiFileContext[] = [];
  for (const attachment of completed) {
    for (const part of attachment.content) {
      if (part.type === "image") {
        images.push(parseImageDataUrl(part.image, part.filename ?? attachment.name));
      } else if (part.type === "file") {
        files.push({ path: part.data, name: part.filename ?? attachment.name });
      }
    }
  }
  if (files.length === 0) return { text, images };
  const fileLines = files.map((file) => formatFileContext(file.path, file.name));
  return {
    text: text.trim()
      ? `${text}\n\n${formatFileContextEnvelope(files)}\n\n${fileLines.join("\n")}`
      : `${formatFileContextEnvelope(files)}\n\n${fileLines.join("\n")}`,
    images,
  };
}

export function toComposerAttachmentInput(attachment: CompleteAttachment): CreateAttachment;
export function toComposerAttachmentInput(attachment: Attachment): File | CreateAttachment;
export function toComposerAttachmentInput(attachment: Attachment): File | CreateAttachment {
  if (!isCompleteAttachment(attachment)) return attachment.file;
  return {
    id: attachment.id,
    type: attachment.type,
    name: attachment.name,
    ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
    content: attachment.content,
  };
}

export async function restoreComposerAttachments(
  addAttachment: (attachment: File | CreateAttachment) => Promise<void>,
  attachments: readonly Attachment[],
  restored: Set<Attachment>,
): Promise<void> {
  for (const attachment of attachments) {
    if (restored.has(attachment)) continue;
    await addAttachment(toComposerAttachmentInput(attachment));
    restored.add(attachment);
  }
}

/** 从 prompt 末尾提取本项目生成的单行文件上下文，供历史消息恢复附件 chip。 */
export function parsePiFileContexts(text: string): ParsedPiFileContexts {
  const lines = text.split("\n");
  let fileCount = 0;
  let index = lines.length;
  while (index > 0 && FILE_CONTEXT_LINE.test(lines[index - 1] ?? "")) {
    fileCount += 1;
    index -= 1;
  }
  if (fileCount === 0) return { text, files: [] };
  if (lines[index - 1] === "") index -= 1;
  const marker = lines[index - 1];
  const envelope = marker ? parseFileContextEnvelope(marker) : undefined;
  if (!envelope || envelope.files.length !== fileCount) return { text, files: [] };
  const fileLines = lines.slice(lines.length - fileCount);
  for (let fileIndex = 0; fileIndex < fileLines.length; fileIndex += 1) {
    const lineFile = parseFileContextLine(fileLines[fileIndex] ?? "");
    const envelopeFile = envelope.files[fileIndex];
    if (!lineFile || !envelopeFile || lineFile.path !== envelopeFile.path || lineFile.name !== envelopeFile.name) {
      return { text, files: [] };
    }
  }
  index -= 1;
  if (lines[index - 1] === "") index -= 1;
  return { text: lines.slice(0, index).join("\n"), files: envelope.files };
}

function isCompleteAttachment(attachment: Attachment): attachment is CompleteAttachment {
  return attachment.status.type === "complete";
}

function formatFileContext(path: string, name: string): string {
  return `<file name="${escapeXml(path)}">${escapeXml(name)}</file>`;
}

function parseFileContextLine(line: string): PiFileContext | undefined {
  const match = FILE_CONTEXT_LINE.exec(line);
  if (!match?.[1] || !match[2]) return undefined;
  return { path: unescapeXml(match[1]), name: unescapeXml(match[2]) };
}

function formatFileContextEnvelope(files: PiFileContext[]): string {
  return `${FILE_CONTEXT_MARKER_PREFIX}${JSON.stringify({ files })}${FILE_CONTEXT_MARKER_SUFFIX}`;
}

function parseFileContextEnvelope(line: string): FileContextEnvelope | undefined {
  const match = FILE_CONTEXT_MARKER_LINE.exec(line);
  if (!match?.[1]) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(match[1]);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const files = (value as { files?: unknown }).files;
  if (!Array.isArray(files) || files.some((file) => !isFileContext(file))) return undefined;
  return { files };
}

function isFileContext(value: unknown): value is PiFileContext {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as PiFileContext).path === "string" &&
    (value as PiFileContext).path.length > 0 &&
    typeof (value as PiFileContext).name === "string" &&
    (value as PiFileContext).name.length > 0
  );
}

function escapeXml(value: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  };
  return value.replace(/[&<>"']/g, (character) => entities[character] ?? character);
}

function unescapeXml(value: string): string {
  const characters: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&apos;": "'",
  };
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (entity) => characters[entity] ?? entity);
}

function parseImageDataUrl(dataUrl: string, name: string): ImageInput {
  const comma = dataUrl.indexOf(",");
  const metadata = comma === -1 ? "" : dataUrl.slice(0, comma);
  const match = /^data:([^;,]+);base64$/i.exec(metadata);
  if (!match?.[1]) throw new Error(`无法读取图片附件: ${name}`);
  return {
    name,
    mimeType: match[1],
    data: dataUrl.slice(comma + 1),
  };
}
