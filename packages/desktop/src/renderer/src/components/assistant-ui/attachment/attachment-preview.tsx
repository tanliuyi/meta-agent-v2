import { cn } from "@renderer/shared/lib/cn";
import { useState } from "react";

export function AttachmentPreview({ src }: { src: string }) {
  const [isLoaded, setIsLoaded] = useState(false);
  return (
    <img
      src={src}
      alt="Attachment preview"
      className={cn(
        "block h-auto max-h-[80vh] w-auto max-w-full object-contain",
        isLoaded ? "aui-attachment-preview-image-loaded" : "aui-attachment-preview-image-loading invisible",
      )}
      onLoad={() => setIsLoaded(true)}
    />
  );
}
