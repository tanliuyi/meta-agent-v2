import { Avatar } from "@renderer/shared/ui/avatar";
import { AvatarFallback } from "@renderer/shared/ui/avatar-fallback";
import { AvatarImage } from "@renderer/shared/ui/avatar-image";
import FileText from "lucide-react/dist/esm/icons/file-text.mjs";
import { useAttachmentSrc } from "./use-attachment-src.ts";

export function AttachmentThumb() {
  const src = useAttachmentSrc();
  return (
    <Avatar className="aui-attachment-tile-avatar h-full w-full rounded-none">
      <AvatarImage src={src} alt="Attachment preview" className="aui-attachment-tile-image object-cover" />
      <AvatarFallback>
        <FileText className="aui-attachment-tile-fallback-icon text-muted-foreground size-8" />
      </AvatarFallback>
    </Avatar>
  );
}
