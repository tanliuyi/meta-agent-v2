/** 工具内容路由器接收的稳定数据模型。 */
export interface ToolContentProps {
  name: string;
  args: Readonly<Record<string, unknown>>;
  result: unknown;
  error: boolean;
}

/** 仅展示工具结果的组件属性。 */
export type ToolResultContentProps = Pick<ToolContentProps, "result" | "error">;

/** 同时展示工具参数与结果的组件属性。 */
export type ToolArgumentsContentProps = Pick<ToolContentProps, "args" | "result" | "error">;
