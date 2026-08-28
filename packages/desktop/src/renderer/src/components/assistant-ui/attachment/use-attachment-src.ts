import { useAuiState } from "@assistant-ui/react";
import { useShallow } from "zustand/shallow";
import { parseSessionImageResourceUrl } from "../../../runtime/session-image-resource-ref.ts";
import { useSessionImageResource } from "../../session-image-resource.ts";
import { useFileSrc } from "./use-file-src.ts";

/** 优先读取待上传 File；历史会话图片通过资源引用按需读取；其他附件使用其持久化地址。 */
export function useAttachmentSrc(): string | undefined {
  const { file, src } = useAuiState(
    useShallow((state): { file?: File; src?: string } => {
      if (state.attachment.type !== "image") return {};
      if (state.attachment.file) return { file: state.attachment.file };
      const image = state.attachment.content?.find((content) => content.type === "image")?.image;
      return image ? { src: image } : {};
    }),
  );
  const resource = parseSessionImageResourceUrl(src);
  const sessionImage = useSessionImageResource(resource);

  return useFileSrc(file) ?? sessionImage.src ?? (resource ? undefined : src);
}
