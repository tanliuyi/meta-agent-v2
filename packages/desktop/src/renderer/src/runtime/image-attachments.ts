import { type Attachment, SimpleImageAttachmentAdapter } from "@assistant-ui/react";
import type { ImageInput } from "../../../shared/contracts.ts";

class PiImageAttachmentAdapter extends SimpleImageAttachmentAdapter {
  override async add(state: { file: File }) {
    const attachment = await super.add(state);
    return { ...attachment, id: crypto.randomUUID() };
  }
}

/** Composer 与 Pi enqueue 共用的图片附件适配器。 */
export const imageAttachmentAdapter = new PiImageAttachmentAdapter();

type ComposerAttachment = Attachment;
type PendingImageAttachment = Parameters<SimpleImageAttachmentAdapter["send"]>[0];
type CompleteImageAttachment = Awaited<ReturnType<SimpleImageAttachmentAdapter["send"]>>;
type CompleteImageAttachmentFn = (attachment: PendingImageAttachment) => Promise<CompleteImageAttachment>;

/** 并行完成独立图片附件，并按 Composer 中的原始顺序生成 Pi IPC 输入。 */
export async function toPiImageInputs(
  attachments: readonly Attachment[],
  completeAttachment: CompleteImageAttachmentFn = (attachment) => imageAttachmentAdapter.send(attachment),
): Promise<ImageInput[]> {
  const completed = await Promise.all(
    attachments.map(async (attachment) => ({
      attachment,
      complete: isPendingImageAttachment(attachment) ? await completeAttachment(attachment) : attachment,
    })),
  );
  return completed.flatMap(({ attachment, complete }) =>
    complete.content.flatMap((part) =>
      part.type === "image" ? [parseImageDataUrl(part.image, part.filename ?? attachment.name)] : [],
    ),
  );
}

function isPendingImageAttachment(attachment: ComposerAttachment): attachment is PendingImageAttachment {
  return attachment.status.type !== "complete";
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
