import { useAuiState } from "@assistant-ui/react";
import { useShallow } from "zustand/shallow";
import { useFileSrc } from "./use-file-src.ts";

/** 优先读取待上传 File 的 object URL，否则使用已完成附件中的持久化图片地址。 */
export function useAttachmentSrc(): string | undefined {
  const { file, src } = useAuiState(
    useShallow((state): { file?: File; src?: string } => {
      if (state.attachment.type !== "image") return {};
      if (state.attachment.file) return { file: state.attachment.file };
      const image = state.attachment.content?.find((content) => content.type === "image")?.image;
      return image ? { src: image } : {};
    }),
  );

  return useFileSrc(file) ?? src;
}
