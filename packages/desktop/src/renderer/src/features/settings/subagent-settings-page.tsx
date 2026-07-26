import { Button } from "@renderer/shared/ui/button";
import { ConfirmDialog } from "@renderer/shared/ui/confirm-dialog";
import { Input } from "@renderer/shared/ui/input";
import { settingsReturnSession } from "@renderer/state/settings-navigation";
import { useSearch } from "@tanstack/react-router";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import { useMemo, useState } from "react";
import type {
  AgentSummary,
  ChainSummary,
  SubagentAgentConfigInput,
  SubagentSettingsMutation,
  SubagentSettingsScope,
} from "../../../../shared/subagent-contracts.ts";
import { SubagentAgentDialog } from "./subagent-agent-dialog.tsx";
import { SubagentAgentSection } from "./subagent-agent-section.tsx";
import { SubagentChainDialog } from "./subagent-chain-dialog.tsx";
import { SubagentChainRow } from "./subagent-chain-row.tsx";
import { SubagentCustomAgentRow } from "./subagent-custom-agent-row.tsx";
import { SubagentExtensionConfigPanel } from "./subagent-extension-config-panel.tsx";
import { useSubagentSettingsController } from "./use-subagent-settings-controller.ts";

type AgentEditor = { agent?: AgentSummary; builtin?: boolean };
type DeleteTarget =
  | { kind: "agent"; name: string; scope: SubagentSettingsScope }
  | { kind: "chain"; name: string; scope: SubagentSettingsScope };

export function SubagentSettingsPage() {
  const search = useSearch({ from: "/settings" });
  const projectId = settingsReturnSession(search)?.projectId;
  const controller = useSubagentSettingsController(projectId);
  const [query, setQuery] = useState("");
  const [agentEditor, setAgentEditor] = useState<AgentEditor>();
  const [chainEditor, setChainEditor] = useState<ChainSummary | null>();
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>();
  const snapshot = controller.snapshot;

  const filtered = useMemo(() => {
    const matches = (value: { name: string; description: string }) =>
      !query.trim() || `${value.name} ${value.description}`.toLowerCase().includes(query.trim().toLowerCase());
    return snapshot
      ? {
          builtin: snapshot.builtinAgents.filter(matches),
          package: snapshot.packageAgents.filter(matches),
          user: snapshot.userAgents.filter(matches),
          project: snapshot.projectAgents.filter(matches),
          chains: snapshot.chains.filter(matches),
        }
      : { builtin: [], package: [], user: [], project: [], chains: [] };
  }, [query, snapshot]);

  const allAgents = useMemo(
    () =>
      snapshot
        ? [
            ...snapshot.projectAgents,
            ...snapshot.userAgents,
            ...snapshot.packageAgents,
            ...snapshot.builtinAgents,
          ].filter((agent, index, agents) => agents.findIndex((candidate) => candidate.name === agent.name) === index)
        : [],
    [snapshot],
  );

  async function saveAgent(scope: SubagentSettingsScope, config: SubagentAgentConfigInput): Promise<boolean> {
    if (agentEditor?.builtin && agentEditor.agent) {
      return controller.mutate({
        type: "update-agent",
        agent: agentEditor.agent.name,
        scope,
        target: "builtin",
        config,
      });
    }
    if (agentEditor?.agent) {
      return controller.mutate({
        type: "update-agent",
        agent: agentEditor.agent.name,
        scope,
        target: "custom",
        config,
      });
    }
    if (!config.name || !config.description) return false;
    return controller.mutate({
      type: "create-agent",
      scope,
      config: { ...config, name: config.name, description: config.description },
    });
  }

  async function saveChain(
    scope: SubagentSettingsScope,
    config: { name: string; description: string; steps: ChainSummary["steps"] },
  ): Promise<boolean> {
    if (chainEditor) {
      return controller.mutate({
        type: "update-chain",
        chain: chainEditor.name,
        scope,
        config,
      });
    }
    return controller.mutate({ type: "create-chain", scope, config });
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
    <div className="settings-content subagent-settings">
      <header className="settings-page-heading subagent-page-heading">
        <div>
          <h2>子智能体</h2>
          {snapshot?.projectId ? <p>用户与当前项目作用域</p> : <p>用户作用域</p>}
        </div>
        <Button
          variant="outline"
          size="icon"
          title="重新加载"
          disabled={controller.loading}
          onClick={() => void controller.reload()}
        >
          <RefreshCw className={controller.loading ? "subagent-spin" : undefined} />
        </Button>
      </header>

      {controller.error ? (
        <div className="subagent-error" role="alert">
          {controller.error}
        </div>
      ) : null}

      <label className="subagent-search">
        <Search />
        <Input
          type="search"
          value={query}
          placeholder="搜索智能体或流程"
          className="pl-8"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      {controller.loading && !snapshot ? <div className="subagent-loading">正在读取配置...</div> : null}

      {snapshot ? (
        <>
          <SubagentAgentSection
            title="内置智能体"
            agents={filtered.builtin}
            mutating={controller.mutating}
            builtin
            onEdit={(agent) => setAgentEditor({ agent, builtin: true })}
            onToggle={(agent, disabled) =>
              controller.mutate({
                type: "set-agent-enabled",
                agent: agent.name,
                disabled,
                scope: agent.overrideScope ?? "user",
              })
            }
            onEject={(agent) => controller.mutate({ type: "eject-agent", agent: agent.name, scope: "user" })}
          />

          {filtered.package.length ? (
            <SubagentAgentSection title="包智能体" agents={filtered.package} mutating={controller.mutating} readOnly />
          ) : null}

          <section className="settings-section subagent-section" aria-labelledby="custom-agents-heading">
            <div className="settings-section-heading subagent-section-heading">
              <h3 id="custom-agents-heading">自定义智能体</h3>
              <Button size="sm" variant="outline" onClick={() => setAgentEditor({})}>
                <Plus />
                新建智能体
              </Button>
            </div>
            {[...filtered.project, ...filtered.user].length ? (
              [...filtered.project, ...filtered.user].map((agent) => (
                <SubagentCustomAgentRow
                  key={`${agent.source}:${agent.filePath}`}
                  agent={agent}
                  disabled={controller.mutating}
                  onEdit={() => setAgentEditor({ agent })}
                  onDelete={() =>
                    setDeleteTarget({ kind: "agent", name: agent.name, scope: agent.source as SubagentSettingsScope })
                  }
                />
              ))
            ) : (
              <div className="settings-row subagent-empty-row">
                {query ? "没有匹配的自定义智能体" : "暂无自定义智能体"}
              </div>
            )}
          </section>

          <section className="settings-section subagent-section" aria-labelledby="chains-heading">
            <div className="settings-section-heading subagent-section-heading">
              <h3 id="chains-heading">流程</h3>
              <Button size="sm" variant="outline" onClick={() => setChainEditor(null)}>
                <Plus />
                新建流程
              </Button>
            </div>
            {filtered.chains.length ? (
              filtered.chains.map((chain) => (
                <SubagentChainRow
                  key={`${chain.source}:${chain.filePath}`}
                  chain={chain}
                  disabled={controller.mutating || chain.source === "package"}
                  onEdit={() => setChainEditor(chain)}
                  onDelete={() =>
                    setDeleteTarget({
                      kind: "chain",
                      name: chain.name,
                      scope: chain.source as SubagentSettingsScope,
                    })
                  }
                />
              ))
            ) : (
              <div className="settings-row subagent-empty-row">{query ? "没有匹配的流程" : "暂无流程"}</div>
            )}
          </section>

          <SubagentExtensionConfigPanel
            key={snapshot.revision}
            config={snapshot.extensionConfig}
            saving={controller.mutating}
            onSave={(config) => controller.mutate({ type: "update-extension-config", config })}
          />

          {snapshot.diagnostics.length ? (
            <section className="settings-section subagent-section" aria-labelledby="subagent-diagnostics-heading">
              <div className="settings-section-heading">
                <h3 id="subagent-diagnostics-heading">诊断</h3>
              </div>
              {snapshot.diagnostics.map((diagnostic, index) => (
                <div className="settings-row subagent-diagnostic" key={`${diagnostic.code}:${index}`}>
                  {diagnostic.message}
                </div>
              ))}
            </section>
          ) : null}

          {agentEditor ? (
            <SubagentAgentDialog
              agent={agentEditor.agent}
              builtin={agentEditor.builtin}
              models={snapshot.models}
              skills={snapshot.skills}
              projectScopeAvailable={snapshot.projectScopeAvailable}
              saving={controller.mutating}
              onClose={() => setAgentEditor(undefined)}
              onSave={saveAgent}
            />
          ) : null}

          {chainEditor !== undefined ? (
            <SubagentChainDialog
              chain={chainEditor ?? undefined}
              agents={allAgents}
              models={snapshot.models}
              skills={snapshot.skills}
              projectScopeAvailable={snapshot.projectScopeAvailable}
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
      ) : null}
    </div>
  );
}
