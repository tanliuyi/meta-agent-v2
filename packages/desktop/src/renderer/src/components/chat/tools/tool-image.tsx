import { useEffect, useState } from "react";
import type { SessionImageResource, SessionImageResourceRef } from "../../../../../shared/contracts.ts";
import { useSessionTransport } from "../../../state/session-navigation.ts";
import { useSessionScope } from "../../session-context.tsx";

interface SessionImageState {
  src?: string;
  loading: boolean;
  error?: string;
}

const pendingImageReads = new Map<string, Promise<SessionImageResource | undefined>>();

function readSessionImageResource(attachmentId: string, resourceId: string): Promise<SessionImageResource | undefined> {
  const key = `${attachmentId}:${resourceId}`;
  const pending = pendingImageReads.get(key);
  if (pending) return pending;
  const request = window.desktop.sessions.readImageResource(attachmentId, resourceId);
  const shared = request.finally(() => {
    if (pendingImageReads.get(key) === shared) pendingImageReads.delete(key);
  });
  pendingImageReads.set(key, shared);
  return shared;
}

/** 按需读取 timeline 图像资源：仅在该组件实际渲染时发起请求，生成 Blob URL 并在卸载/替换时 revoke。 */
export function useSessionImageResource(resource: SessionImageResourceRef | undefined): SessionImageState {
  const { record } = useSessionScope();
  const transport = useSessionTransport();
  const [state, setState] = useState<SessionImageState>({ loading: false });
  useEffect(() => {
    if (!resource) {
      setState({ loading: false });
      return;
    }
    if (resource.unavailable) {
      setState({
        loading: false,
        error: resource.unavailable === "too-large" ? "图像超过加载上限" : "会话图像资源预算已耗尽",
      });
      return;
    }
    let cancelled = false;
    let objectUrl: string | undefined;
    setState({ loading: true });
    const attachmentId = transport.getCommittedAttachmentId(record);
    if (!attachmentId) {
      setState({ loading: false, error: "会话连接未就绪" });
      return;
    }
    void readSessionImageResource(attachmentId, resource.resourceId)
      .then((image) => {
        if (cancelled) return;
        if (!image) {
          setState({ loading: false, error: "图像资源不可用" });
          return;
        }
        const binary = atob(image.data);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: image.mimeType }));
        setState({ src: objectUrl, loading: false });
      })
      .catch((error) => {
        if (cancelled) return;
        setState({ loading: false, error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [record, transport, resource?.resourceId, resource?.unavailable]);
  return state;
}

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
