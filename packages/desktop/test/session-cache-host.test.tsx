import { describe, expect, it } from "vitest";
import { SessionCacheHost } from "../src/renderer/src/components/session-cache-host.tsx";
import { SessionProvider } from "../src/renderer/src/components/session-provider.tsx";
import { SessionSurface } from "../src/renderer/src/components/session-surface.tsx";
import { createSessionRecord } from "../src/renderer/src/runtime/pi-session-store.ts";

describe("SessionCacheHost", () => {
  it("没有 active record 时不挂载 session subtree", () => {
    const record = createSessionRecord({ projectId: "project", threadId: "thread" });

    expect(SessionCacheHost({ records: [record], activeKey: null })).toBeNull();
    expect(SessionCacheHost({ records: [record], activeKey: "missing" })).toBeNull();
  });

  it("只挂载当前 active record 的 workspace", () => {
    const inactive = createSessionRecord({ projectId: "project", threadId: "inactive" });
    const active = createSessionRecord({ projectId: "project", threadId: "active" });
    const mounted = SessionCacheHost({ records: [inactive, active], activeKey: active.key });

    expect(mounted).not.toBeNull();
    expect(mounted?.type).toBe(SessionProvider);
    expect(mounted?.props).toMatchObject({ record: active, active: true });
    expect(mounted?.props.children.type).toBe(SessionSurface);
  });
});
