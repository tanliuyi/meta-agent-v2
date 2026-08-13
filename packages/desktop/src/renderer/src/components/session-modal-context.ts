import { createContext, useContext } from "react";

/**
 * 标记当前 ChatThread 是否渲染在全屏会话 modal 中。
 * 普通聊天（侧边栏内联）不包裹 Provider，读取结果为 false。
 * 用于在 modal 内调整子组件的默认行为（如思考链默认收起）。
 */
export const SessionModalContext = createContext(false);

export function useSessionModalContext(): boolean {
  return useContext(SessionModalContext);
}
