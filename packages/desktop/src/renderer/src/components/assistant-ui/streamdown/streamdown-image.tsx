import { AttachmentPreview } from "@renderer/components/assistant-ui/attachment/attachment-preview";
import { TooltipIconButton } from "@renderer/components/assistant-ui/tooltip-icon-button";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import CircleAlert from "lucide-react/dist/esm/icons/circle-alert.mjs";
import Download from "lucide-react/dist/esm/icons/download.mjs";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";
import Maximize from "lucide-react/dist/esm/icons/maximize.mjs";
import Quote from "lucide-react/dist/esm/icons/quote.mjs";
import { type ComponentPropsWithoutRef, useEffect, useRef, useState } from "react";
import {
  markdownImageFilename,
  markdownImageReference,
  markdownImageSourceToUrl,
} from "../../../../../shared/markdown-image-contracts.ts";
import { useMarkdownImageReference } from "./streamdown-image-reference.tsx";

type MarkdownImageProps = ComponentPropsWithoutRef<"img"> & { node?: unknown };
type DownloadState = "idle" | "downloading" | "downloaded" | "error";

export function MarkdownImage({ src, alt = "", className, node: _node, ...props }: MarkdownImageProps) {
  const referenceImage = useMarkdownImageReference();
  const resetTimer = useRef<number | undefined>(undefined);
  const [downloadState, setDownloadState] = useState<DownloadState>("idle");
  const [referenced, setReferenced] = useState(false);
  const resolvedSrc = src ? markdownImageSourceToUrl(src) : undefined;
  const imageClassName = className ? `markdown-image ${className}` : "markdown-image";
  const description = alt || "Markdown 图片";

  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  const resetFeedbackAfterDelay = (callback: () => void) => {
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(callback, 2_000);
  };

  const downloadImage = async () => {
    if (!resolvedSrc || downloadState === "downloading") return;
    setDownloadState("downloading");
    try {
      const response = await fetch(resolvedSrc);
      if (!response.ok) throw new Error(`Unable to download image: ${response.status}`);
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = markdownImageFilename(src ?? "", alt);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      setDownloadState("downloaded");
      resetFeedbackAfterDelay(() => setDownloadState("idle"));
    } catch {
      setDownloadState("error");
      resetFeedbackAfterDelay(() => setDownloadState("idle"));
    }
  };

  const reference = () => {
    if (!src || !referenceImage) return;
    referenceImage(markdownImageReference(src, alt));
    setReferenced(true);
    resetFeedbackAfterDelay(() => setReferenced(false));
  };

  if (!resolvedSrc) return null;

  return (
    <AttachmentPreview src={resolvedSrc}>
      <figure className="markdown-image-block" data-streamdown="image-block">
        <button type="button" className="markdown-image-preview-trigger" aria-label={`预览图片：${description}`}>
          <img
            {...props}
            className={imageClassName}
            src={resolvedSrc}
            alt={alt}
            loading="lazy"
            decoding="async"
            draggable={false}
          />
        </button>
        <div className="markdown-image-actions" data-streamdown="image-actions">
          <TooltipIconButton className="markdown-image-action" tooltip="预览图片" side="top">
            <Maximize aria-hidden="true" />
          </TooltipIconButton>
          <TooltipIconButton
            className="markdown-image-action"
            tooltip={downloadState === "downloaded" ? "已下载" : downloadState === "error" ? "下载失败" : "下载图片"}
            side="top"
            disabled={downloadState === "downloading"}
            onClick={(event) => {
              event.stopPropagation();
              void downloadImage();
            }}
          >
            {downloadState === "downloading" ? (
              <LoaderCircle className="animate-spin" aria-hidden="true" />
            ) : downloadState === "downloaded" ? (
              <Check aria-hidden="true" />
            ) : downloadState === "error" ? (
              <CircleAlert aria-hidden="true" />
            ) : (
              <Download aria-hidden="true" />
            )}
          </TooltipIconButton>
          {referenceImage ? (
            <TooltipIconButton
              className="markdown-image-action"
              tooltip={referenced ? "已引用" : "引用图片"}
              side="top"
              onClick={(event) => {
                event.stopPropagation();
                reference();
              }}
            >
              {referenced ? <Check aria-hidden="true" /> : <Quote aria-hidden="true" />}
            </TooltipIconButton>
          ) : null}
        </div>
      </figure>
    </AttachmentPreview>
  );
}
