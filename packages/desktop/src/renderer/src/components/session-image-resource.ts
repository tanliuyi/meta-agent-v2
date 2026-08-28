import { useEffect, useState } from "react";
import type { SessionImageResourceRef } from "../../../shared/contracts.ts";
import { useSessionTransport } from "../state/session-navigation.ts";
import { useSessionConnection, useSessionScope } from "./session-context.tsx";

interface SessionImageState {
  src?: string;
  loading: boolean;
  error?: string;
}

interface SharedImageEntry {
  refs: number;
  objectUrl?: string;
  promise: Promise<string>;
}

const sharedImages = new Map<string, SharedImageEntry>();

export function acquireSessionImageResource(
  attachmentId: string,
  resourceId: string,
): { promise: Promise<string>; release(): void } {
  const key = `${attachmentId}:${resourceId}`;
  let entry = sharedImages.get(key);
  if (!entry) {
    const created: SharedImageEntry = { refs: 0, promise: Promise.resolve("") };
    created.promise = window.desktop.sessions
      .readImageResource(attachmentId, resourceId)
      .then((image) => {
        if (!image) throw new Error("图像资源不可用");
        const binary = atob(image.data);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        created.objectUrl = URL.createObjectURL(new Blob([bytes], { type: image.mimeType }));
        return created.objectUrl;
      })
      .finally(() => {
        if (created.refs !== 0 || sharedImages.get(key) !== created) return;
        if (created.objectUrl) URL.revokeObjectURL(created.objectUrl);
        sharedImages.delete(key);
      });
    sharedImages.set(key, created);
    entry = created;
  }
  entry.refs += 1;
  let released = false;
  return {
    promise: entry.promise,
    release: () => {
      if (released) return;
      released = true;
      entry.refs -= 1;
      if (entry.refs !== 0 || !entry.objectUrl || sharedImages.get(key) !== entry) return;
      URL.revokeObjectURL(entry.objectUrl);
      sharedImages.delete(key);
    },
  };
}

/** 实际渲染图像时按需读取资源；同一 attachment/resource 的读取、解码和 Blob URL 由挂载消费者共享。 */
export function useSessionImageResource(resource: SessionImageResourceRef | undefined): SessionImageState {
  const { record } = useSessionScope();
  const connection = useSessionConnection();
  const transport = useSessionTransport();
  const [state, setState] = useState<SessionImageState>({ loading: false });
  const resourceId = resource?.resourceId;
  useEffect(() => {
    if (!resourceId) {
      setState({ loading: false });
      return;
    }
    if (connection !== "ready") {
      setState({ loading: true });
      return;
    }
    const attachmentId = transport.getCommittedAttachmentId(record);
    if (!attachmentId) {
      setState({ loading: false, error: "会话连接未就绪" });
      return;
    }
    let cancelled = false;
    setState({ loading: true });
    const acquired = acquireSessionImageResource(attachmentId, resourceId);
    void acquired.promise
      .then((src) => {
        if (!cancelled) setState({ src, loading: false });
      })
      .catch((error) => {
        if (!cancelled) setState({ loading: false, error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
      acquired.release();
    };
  }, [connection, record, transport, resourceId]);
  return state;
}
