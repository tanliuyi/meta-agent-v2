const BUILTIN_SUBAGENT_NAMES: Readonly<Record<string, string>> = {
  advisor: "顾问",
  "context-builder": "上下文构建器",
  delegate: "委派代理",
  oracle: "决策智囊",
  planner: "规划师",
  researcher: "研究员",
  reviewer: "审查员",
  scout: "侦察员",
  worker: "执行者",
};

export function builtinSubagentDisplayName(name: string): string {
  return BUILTIN_SUBAGENT_NAMES[name] ?? name;
}
