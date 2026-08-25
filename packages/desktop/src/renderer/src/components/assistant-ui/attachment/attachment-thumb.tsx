import { useAuiState } from "@assistant-ui/react";
import { Avatar } from "@renderer/shared/ui/avatar";
import { AvatarFallback } from "@renderer/shared/ui/avatar-fallback";
import { AvatarImage } from "@renderer/shared/ui/avatar-image";
import FileArchive from "lucide-react/dist/esm/icons/file-archive.mjs";
import FileAudio from "lucide-react/dist/esm/icons/file-audio.mjs";
import FileBox from "lucide-react/dist/esm/icons/file-box.mjs";
import FileChartColumn from "lucide-react/dist/esm/icons/file-chart-column.mjs";
import FileCode from "lucide-react/dist/esm/icons/file-code.mjs";
import FileSpreadsheet from "lucide-react/dist/esm/icons/file-spreadsheet.mjs";
import FileText from "lucide-react/dist/esm/icons/file-text.mjs";
import FileVideo from "lucide-react/dist/esm/icons/file-video.mjs";
import type { ReactNode } from "react";
import { type AttachmentFileKind, getAttachmentFileKind } from "./attachment-file-kind.ts";
import { useAttachmentSrc } from "./use-attachment-src.ts";

export function AttachmentThumb() {
  const src = useAttachmentSrc();
  const name = useAuiState((state) => state.attachment.name);
  const contentType = useAuiState((state) => state.attachment.contentType);
  return (
    <Avatar className="aui-attachment-tile-avatar h-full w-full rounded-none">
      <AvatarImage src={src} alt="Attachment preview" className="aui-attachment-tile-image object-cover" />
      <AvatarFallback>{fileKindIcon(getAttachmentFileKind(name, contentType))}</AvatarFallback>
    </Avatar>
  );
}

function fileKindIcon(kind: AttachmentFileKind) {
  const iconClassName = "aui-attachment-tile-fallback-icon size-7";
  switch (kind) {
    case "pdf":
      return labeledFileIcon(<FileText className={`${iconClassName} text-destructive`} />, "PDF");
    case "word":
      return labeledFileIcon(<FileText className={`${iconClassName} text-info`} />, "DOC");
    case "spreadsheet":
      return labeledFileIcon(<FileSpreadsheet className={`${iconClassName} text-success`} />, "XLS");
    case "presentation":
      return labeledFileIcon(<FileChartColumn className={`${iconClassName} text-warning`} />, "PPT");
    case "archive":
      return labeledFileIcon(<FileArchive className={`${iconClassName} text-warning`} />, "ZIP");
    case "code":
      return <FileCode className={`${iconClassName} text-primary`} />;
    case "audio":
      return <FileAudio className={`${iconClassName} text-warning`} />;
    case "video":
      return <FileVideo className={`${iconClassName} text-info`} />;
    case "executable":
      return labeledFileIcon(<FileBox className={`${iconClassName} text-primary`} />, "APP");
    case "generic":
      return <FileText className={`${iconClassName} text-muted-foreground`} />;
  }
}

function labeledFileIcon(icon: ReactNode, label: string) {
  return (
    <span className="relative flex size-full items-center justify-center" aria-hidden="true">
      {icon}
      <span className="bg-background absolute right-0.5 bottom-0.5 rounded-sm px-0.5 text-[8px] leading-3 font-bold">
        {label}
      </span>
    </span>
  );
}
