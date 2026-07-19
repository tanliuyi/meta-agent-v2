import { useDesktopSelector } from "../../state/desktop-context.tsx";
import { selectActiveHostRequest, selectActiveProjectId, selectActiveThreadId } from "../../state/desktop-selectors.ts";
import { HostRequests } from "./host-requests.tsx";

/** 仅让扩展请求表面订阅首个 request 与 session identity。 */
export function SessionHostRequests() {
  const request = useDesktopSelector(selectActiveHostRequest);
  const projectId = useDesktopSelector(selectActiveProjectId);
  const threadId = useDesktopSelector(selectActiveThreadId);
  return request && projectId && threadId ? (
    <HostRequests request={request} projectId={projectId} threadId={threadId} />
  ) : null;
}
