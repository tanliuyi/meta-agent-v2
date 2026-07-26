import { Button } from "@renderer/shared/ui/button";
import Pencil from "lucide-react/dist/esm/icons/pencil.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import type { AgentSummary } from "../../../../shared/subagent-contracts.ts";

interface SubagentCustomAgentRowProps {
  agent: AgentSummary;
  disabled: boolean;
  onEdit(): void;
  onDelete(): void;
}

export function SubagentCustomAgentRow({ agent, disabled, onEdit, onDelete }: SubagentCustomAgentRowProps) {
  return (
    <div className="settings-row subagent-row">
      <div className="subagent-identity">
        <div className="subagent-title-line">
          <strong>{agent.name}</strong>
          <span className="subagent-scope-badge">{agent.source}</span>
          {agent.overridden ? <span className="subagent-scope-badge">{agent.overrideScope} override</span> : null}
        </div>
        <p>{agent.description}</p>
        <span className="subagent-model-label">{agent.model || "继承当前会话模型"}</span>
      </div>
      <div className="subagent-row-actions">
        <Button variant="ghost" size="sm" disabled={disabled} onClick={onEdit}>
          <Pencil />
          编辑
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          title="删除智能体"
          disabled={disabled}
          onClick={onDelete}
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}
