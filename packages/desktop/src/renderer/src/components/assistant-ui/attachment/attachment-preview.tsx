import Image from "@rc-component/image";
import { cn } from "@renderer/shared/lib/cn";
import {
  type CSSProperties,
  cloneElement,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import "@rc-component/image/assets/index.css";
import {
  MAX_IMAGE_PREVIEW_SCALE,
  MIN_IMAGE_PREVIEW_SCALE,
  renderImagePreviewToolbar,
} from "./image-preview-toolbar.tsx";

type AttachmentPreviewProps = {
  children: ReactElement;
  src: string;
};

type ImagePreviewElementProps = {
  className?: string;
  style?: CSSProperties;
};

const IMAGE_PREVIEW_TRANSITION_TYPE = "aui-image-preview";
const INVALID_VIEW_TRANSITION_NAME_CHARACTERS = /[^a-zA-Z0-9_-]/g;

export function AttachmentPreview({ children, src }: AttachmentPreviewProps) {
  const heroName = `aui-image-preview-hero-${useId().replaceAll(INVALID_VIEW_TRANSITION_NAME_CHARACTERS, "")}`;
  const transitionRef = useRef<ViewTransition | null>(null);
  const [open, setOpen] = useState(false);
  const triggerElement = children as ReactElement<ImagePreviewElementProps>;
  const trigger = cloneElement(triggerElement, {
    className: cn(triggerElement.props.className, "aui-image-preview-hero"),
    style: {
      ...triggerElement.props.style,
      viewTransitionName: open ? "none" : heroName,
    },
  });

  const renderPreviewImage = useCallback(
    (originalNode: ReactElement) => {
      const imageElement = originalNode as ReactElement<ImagePreviewElementProps>;
      const previewImage = cloneElement(imageElement, {
        className: cn(imageElement.props.className, "aui-image-preview-hero"),
        style: {
          ...imageElement.props.style,
          viewTransitionName: open ? heroName : "none",
        },
      });
      return <div className="aui-image-preview-image-stage">{previewImage}</div>;
    },
    [heroName, open],
  );

  const updateOpen = useCallback((nextOpen: boolean) => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!document.startViewTransition || reducedMotion) {
      setOpen(nextOpen);
      return;
    }

    transitionRef.current?.skipTransition();
    const transition = document.startViewTransition({
      types: [IMAGE_PREVIEW_TRANSITION_TYPE],
      update: () => flushSync(() => setOpen(nextOpen)),
    });
    transitionRef.current = transition;
    void transition.finished
      .catch(() => undefined)
      .finally(() => {
        if (transitionRef.current !== transition) return;
        transitionRef.current = null;
      });
  }, []);

  useEffect(
    () => () => {
      transitionRef.current?.skipTransition();
      transitionRef.current = null;
    },
    [],
  );

  return (
    <Image
      src={src}
      alt=""
      aria-label="预览图片"
      tabIndex={-1}
      classNames={{
        root: "aui-image-preview-trigger mb-2",
        image: "aui-image-preview-trigger-image",
        cover: "aui-image-preview-trigger-cover",
        popup: {
          root: cn(
            "aui-image-preview",
            typeof window !== "undefined" && window.desktop.platform === "darwin" && "aui-image-preview-macos",
          ),
        },
      }}
      preview={{
        src,
        closeIcon: false,
        cover: { coverNode: trigger, placement: "center" },
        focusTrap: false,
        imageRender: renderPreviewImage,
        maskClosable: true,
        maxScale: MAX_IMAGE_PREVIEW_SCALE,
        minScale: MIN_IMAGE_PREVIEW_SCALE,
        motionName: "",
        onOpenChange: updateOpen,
        open,
        scaleStep: 0.25,
        actionsRender: renderImagePreviewToolbar,
      }}
    />
  );
}
