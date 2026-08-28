import type { SessionImageResourceRef } from "../../../../../shared/contracts.ts";
import { useSessionImageResource } from "../../session-image-resource.ts";

/** 工具输出图像：资源引用按需从 worker 读取；加载/失败状态稳定展示。 */
export function ToolImage({
  resource,
  alt,
  className,
}: {
  resource: SessionImageResourceRef;
  alt: string;
  className?: string;
}) {
  const { src, loading, error } = useSessionImageResource(resource);
  if (error) return <span className="tool-image-error">{error}</span>;
  if (!src) return loading ? <span className="tool-image-loading">图像加载中…</span> : null;
  return <img className={className} src={src} alt={alt} />;
}
