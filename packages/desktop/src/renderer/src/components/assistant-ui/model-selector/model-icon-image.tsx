import { cn } from "@renderer/shared/lib/cn";

/** Renders a local brand SVG without making it part of the accessible label. */
export function ModelIconImage({ src, className }: { src: string; className?: string }) {
  return (
    <img src={src} alt="" aria-hidden="true" draggable={false} className={cn("size-3.5 object-contain", className)} />
  );
}
