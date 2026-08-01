import { Button } from "@renderer/shared/ui/button";
import { Collapsible } from "@renderer/shared/ui/collapsible";
import { CollapsibleContent } from "@renderer/shared/ui/collapsible-content";
import { CollapsibleTrigger } from "@renderer/shared/ui/collapsible-trigger";
import { Switch } from "@renderer/shared/ui/switch";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import Pencil from "lucide-react/dist/esm/icons/pencil.mjs";
import type { AgentSummary } from "../../../../shared/subagent-contracts.ts";
import { builtinSubagentDisplayName } from "../../shared/lib/builtin-subagent-name.ts";

interface SubagentAgentSectionProps {
  title: string;
  agents: AgentSummary[];
  mutating: boolean;
  builtin?: boolean;
  readOnly?: boolean;
  copyLabel?: string;
  defaultCollapsed?: boolean;
  onEdit?(agent: AgentSummary): void;
  onToggle?(agent: AgentSummary, disabled: boolean): Promise<boolean>;
  onEject?(agent: AgentSummary): Promise<boolean>;
}

export function SubagentAgentSection({
  title,
  agents,
  mutating,
  builtin = false,
  readOnly = false,
  copyLabel = "复制",
  defaultCollapsed = false,
  onEdit,
  onToggle,
  onEject,
}: SubagentAgentSectionProps) {
  const headingId = `subagent-${title.replace(/\s+/g, "-").toLowerCase()}`;
  const content = agents.length ? (
    agents.map((agent) => {
      const displayName = builtin ? builtinSubagentDisplayName(agent.name) : agent.name;
      return (
        <div className="settings-row subagent-row" key={`${agent.source}:${agent.filePath}`}>
          <div className="subagent-identity">
            <div className="subagent-title-line">
              <strong>{displayName}</strong>
              <span className="subagent-scope-badge">{agent.source}</span>
              {agent.overridden ? <span className="subagent-scope-badge">{agent.overrideScope} override</span> : null}
            </div>
            <p>{agent.description}</p>
            <span className="subagent-model-label">{agent.model || "继承当前会话模型"}</span>
          </div>
          <div className="subagent-row-actions">
            {builtin ? (
              <Switch
                aria-label={`${agent.name} 启用状态`}
                checked={!agent.disabled}
                disabled={mutating}
                onCheckedChange={(checked) => void onToggle?.(agent, !checked)}
              />
            ) : null}
            {!readOnly ? (
              <Button variant="ghost" size="sm" disabled={mutating} onClick={() => onEdit?.(agent)}>
                <Pencil />
                编辑
              </Button>
            ) : null}
            {builtin ? (
              <Button variant="ghost" size="sm" disabled={mutating} onClick={() => void onEject?.(agent)}>
                <Copy />
                {copyLabel}
              </Button>
            ) : null}
          </div>
        </div>
      );
    })
  ) : (
    <div className="settings-row subagent-empty-row">没有匹配的 Agent</div>
  );

  if (!defaultCollapsed) {
    return (
      <section className="settings-section subagent-section" aria-labelledby={headingId}>
        <div className="settings-section-heading">
          <h3 id={headingId}>{title}</h3>
        </div>
        {content}
      </section>
    );
  }

  return (
    <Collapsible asChild defaultOpen={false}>
      <section className="settings-section subagent-section" aria-labelledby={headingId}>
        <div className="settings-section-heading subagent-collapsible-header">
          <h3 id={headingId} className="subagent-collapsible-title">
            <CollapsibleTrigger type="button" className="subagent-collapsible-heading">
              <span>{title}</span>
              <ChevronDown aria-hidden="true" />
            </CollapsibleTrigger>
          </h3>
        </div>
        <CollapsibleContent>{content}</CollapsibleContent>
      </section>
    </Collapsible>
  );
}
