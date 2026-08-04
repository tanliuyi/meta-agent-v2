import { Button } from "@renderer/shared/ui/button";
import Pencil from "lucide-react/dist/esm/icons/pencil.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import type { ChainSummary } from "../../../../../shared/subagent-contracts.ts";

interface SubagentChainRowProps {
  chain: ChainSummary;
  disabled: boolean;
  onEdit(): void;
  onDelete(): void;
}

export function SubagentChainRow({ chain, disabled, onEdit, onDelete }: SubagentChainRowProps) {
  return (
    <div className="settings-row subagent-row">
      <div className="subagent-identity">
        <div className="subagent-title-line">
          <strong>{chain.name}</strong>
          <span className="subagent-scope-badge">{chain.source}</span>
          <span className="subagent-scope-badge">{chain.stepCount} 步</span>
        </div>
        <p>{chain.description}</p>
        <span className="subagent-model-label">
          {chain.editBlockedReason ?? chain.steps.map((step) => step.agent).join(" → ")}
        </span>
      </div>
      <div className="subagent-row-actions">
        <Button
          variant="ghost"
          size="sm"
          title={chain.editBlockedReason}
          disabled={disabled || !chain.editable}
          onClick={onEdit}
        >
          <Pencil />
          编辑
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          title="删除流程"
          disabled={disabled}
          onClick={onDelete}
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}
