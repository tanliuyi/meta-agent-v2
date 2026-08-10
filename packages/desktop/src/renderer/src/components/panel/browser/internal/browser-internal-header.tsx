import type { ReactNode } from "react";

/** 内部页通用头部（标题 + 右侧操作区）。 */
export function BrowserInternalPageHeader({ title, actions }: { title: string; actions?: ReactNode }): ReactNode {
  return (
    <div className="browser-internal-page-header">
      <h2 className="browser-internal-page-title">{title}</h2>
      {actions ? <div className="browser-internal-page-actions">{actions}</div> : null}
    </div>
  );
}
