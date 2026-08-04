import { ConfirmDialog } from "@renderer/shared/ui/confirm-dialog";
import { forwardRef, useImperativeHandle, useState } from "react";
import type {
  AgentSummary,
  ChainSummary,
  SubagentAgentConfigInput,
  SubagentSettingsMutation,
  SubagentSettingsScope,
  SubagentSettingsSnapshot,
} from "../../../../../shared/subagent-contracts.ts";
import { SubagentAgentDialog } from "./subagent-agent-dialog.tsx";
import { SubagentChainDialog } from "./subagent-chain-dialog.tsx";
import type { SubagentSettingsController } from "./use-subagent-settings-controller.ts";

type AgentEditor = { agent?: AgentSummary; builtin?: boolean };
type DeleteTarget =
  | { kind: "agent"; name: string; scope: SubagentSettingsScope }
  | { kind: "chain"; name: string; scope: SubagentSettingsScope };

export interface SubagentSettingsDialogsHandle {
  close(): void;
  openAgent(agent?: AgentSummary, builtin?: boolean): void;
  openChain(chain?: ChainSummary): void;
  requestDelete(target: DeleteTarget): void;
}

interface SubagentSettingsDialogsProps {
  allAgents: AgentSummary[];
  controller: SubagentSettingsController;
  scope: SubagentSettingsScope;
  snapshot?: SubagentSettingsSnapshot;
  systemTab: boolean;
}

export const SubagentSettingsDialogs = forwardRef<SubagentSettingsDialogsHandle, SubagentSettingsDialogsProps>(
  ({ allAgents, controller, scope, snapshot, systemTab }, ref) => {
    const [agentEditor, setAgentEditor] = useState<AgentEditor>();
    const [chainEditor, setChainEditor] = useState<ChainSummary | null>();
    const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>();

    useImperativeHandle(
      ref,
      () => ({
        close() {
          setAgentEditor(undefined);
          setChainEditor(undefined);
          setDeleteTarget(undefined);
        },
        openAgent(agent, builtin) {
          setAgentEditor({ agent, builtin });
        },
        openChain(chain) {
          setChainEditor(chain ?? null);
        },
        requestDelete(target) {
          setDeleteTarget(target);
        },
      }),
      [],
    );

    async function saveAgent(targetScope: SubagentSettingsScope, config: SubagentAgentConfigInput): Promise<boolean> {
      if (agentEditor?.builtin && agentEditor.agent) {
        return controller.mutate({
          type: "update-agent",
          agent: agentEditor.agent.name,
          scope: targetScope,
          target: "builtin",
          config,
        });
      }
      if (agentEditor?.agent) {
        return controller.mutate({
          type: "update-agent",
          agent: agentEditor.agent.name,
          scope: targetScope,
          target: "custom",
          config,
        });
      }
      if (!config.name || !config.description) return false;
      return controller.mutate({
        type: "create-agent",
        scope: targetScope,
        config: { ...config, name: config.name, description: config.description },
      });
    }

    async function saveChain(
      targetScope: SubagentSettingsScope,
      config: { name: string; description: string; steps: ChainSummary["steps"] },
    ): Promise<boolean> {
      if (chainEditor) {
        return controller.mutate({
          type: "update-chain",
          chain: chainEditor.name,
          scope: targetScope,
          config,
        });
      }
      return controller.mutate({ type: "create-chain", scope: targetScope, config });
    }

    async function confirmDelete(): Promise<void> {
      if (!deleteTarget) return;
      const mutation: SubagentSettingsMutation =
        deleteTarget.kind === "agent"
          ? { type: "delete-agent", agent: deleteTarget.name, scope: deleteTarget.scope }
          : { type: "delete-chain", chain: deleteTarget.name, scope: deleteTarget.scope };
      if (await controller.mutate(mutation)) setDeleteTarget(undefined);
    }

    return (
      <>
        {!systemTab && agentEditor && snapshot ? (
          <SubagentAgentDialog
            agent={agentEditor.agent}
            builtin={agentEditor.builtin}
            models={snapshot.models}
            skills={snapshot.skills}
            scope={scope}
            saving={controller.mutating}
            onClose={() => setAgentEditor(undefined)}
            onSave={saveAgent}
          />
        ) : null}

        {!systemTab && chainEditor !== undefined && snapshot ? (
          <SubagentChainDialog
            chain={chainEditor ?? undefined}
            agents={allAgents}
            models={snapshot.models}
            skills={snapshot.skills}
            scope={scope}
            saving={controller.mutating}
            onClose={() => setChainEditor(undefined)}
            onSave={saveChain}
          />
        ) : null}

        <ConfirmDialog
          open={Boolean(deleteTarget)}
          title={`删除 ${deleteTarget?.name ?? ""}？`}
          description="对应作用域中的定义文件将被删除。"
          onOpenChange={(open) => !open && setDeleteTarget(undefined)}
          onConfirm={() => void confirmDelete()}
        />
      </>
    );
  },
);

SubagentSettingsDialogs.displayName = "SubagentSettingsDialogs";
