import { ToolCode } from "./tool-code.tsx";
import type { ToolArgumentsContentProps } from "./tool-content-types.ts";
import { parseToolResultRecord, readToolStringArgument } from "./tool-format.ts";
import { ToolResult } from "./tool-result.tsx";

const ACTION_DONE_LABELS: Readonly<Record<string, string>> = {
  create: "技能已创建",
  patch: "技能已更新",
  update: "技能已更新",
  edit: "技能已更新",
  delete: "技能已删除",
};

/** 展示 skill_manage 的技能描述、正文与人话结果，不落原始 JSON。 */
export function SkillManageContent({ args, result, error, expanded }: ToolArgumentsContentProps) {
  const action = readToolStringArgument(args, "action");
  const description = readToolStringArgument(args, "description");
  const content = readToolStringArgument(args, "content");
  const record = parseToolResultRecord(result);
  const errorText = typeof record?.error === "string" ? record.error : undefined;
  const message = typeof record?.message === "string" ? record.message : undefined;
  const body = typeof record?.body === "string" ? record.body : undefined;
  const skills = Array.isArray(record?.skills) ? record.skills : [];

  return (
    <>
      {description ? <div className="tool-note">{description}</div> : null}
      {content ? <ToolCode value={content} expanded={expanded} /> : null}
      {body ? <ToolCode value={body} expanded={expanded} previewLines={15} /> : null}
      {skills.length > 0 ? (
        <div className="tool-subagent-section">
          {skills.map((skill, index) => {
            if (!skill || typeof skill !== "object") return null;
            const entry = skill as Record<string, unknown>;
            const name = typeof entry.name === "string" ? entry.name : `技能 ${index + 1}`;
            const skillDescription = typeof entry.description === "string" ? entry.description : "";
            return (
              <div className="tool-subagent-task" key={name}>
                <span className="tool-subagent-agent">{name}</span>
                {skillDescription ? <span className="tool-subagent-task-text">{skillDescription}</span> : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {record?.success === true && action !== "view" ? (
        <div className="tool-note" data-tone="success">
          {message ?? ACTION_DONE_LABELS[action] ?? "操作成功"}
        </div>
      ) : null}
      {errorText ? (
        <div className="tool-note" data-tone="destructive">
          {errorText}
        </div>
      ) : null}
      {result !== undefined && !record ? <ToolResult result={result} error={error} expanded={expanded} /> : null}
    </>
  );
}
