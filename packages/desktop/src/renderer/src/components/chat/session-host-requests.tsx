import { useSessionControl, useSessionScope } from "../session-context.tsx";
import { HostRequests } from "./host-requests.tsx";

/** Host UI requests are routed to the session record that received the control push. */
export function SessionHostRequests() {
  const { record } = useSessionScope();
  const control = useSessionControl();
  const request = control?.hostRequests[0];
  return request ? (
    <HostRequests request={request} projectId={record.identity.projectId} threadId={record.identity.threadId} />
  ) : null;
}
