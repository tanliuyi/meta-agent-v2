import { type ReactNode } from "react";
import { TransportProvider } from "../runtime/session-transport-context";
import { DraftSessionProvider } from "./draft-session-context";
import { SessionCacheProvider } from "./session-cache-context";
import { SessionDraftProvider } from "./session-draft-context";
import { WorkbenchTabProvider } from "./workbench-tab-context";

/**
 * 为 root render 注入 session cache 基础设施。
 * 位于 app 与 runtime 之间，确保 app 不直接导入 runtime。
 * WorkbenchTabProvider 与 SessionDraftProvider 依赖 session cache 记录
 * （按主 session 隔离 tab 与草稿，并清理已 retire 状态）。
 */
export function DesktopCacheProviders({ children }: { children: ReactNode }) {
  return (
    <TransportProvider>
      <SessionCacheProvider>
        <WorkbenchTabProvider>
          <DraftSessionProvider>
            <SessionDraftProvider>{children}</SessionDraftProvider>
          </DraftSessionProvider>
        </WorkbenchTabProvider>
      </SessionCacheProvider>
    </TransportProvider>
  );
}
