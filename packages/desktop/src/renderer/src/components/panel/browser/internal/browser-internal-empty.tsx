import type { ReactNode } from "react";

/** 内部页空状态占位。 */
export function BrowserInternalEmpty({ text }: { text: string }): ReactNode {
  return <div className="browser-internal-empty">{text}</div>;
}
