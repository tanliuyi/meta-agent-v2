import * as Tabs from "@radix-ui/react-tabs";
import { Button } from "@renderer/shared/ui/button";
import { ConfirmDialog } from "@renderer/shared/ui/confirm-dialog";
import { Input } from "@renderer/shared/ui/input";
import { selectProjects } from "@renderer/state/desktop-selectors";
import { useDesktopStore } from "@renderer/state/desktop-store-context";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import { isUserProject } from "../../../../shared/contracts.ts";
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
import { resolveSubagentSettingsActiveTab, useSubagentSettingsController } from "./use-subagent-settings-controller.ts";

const USER_TAB = "user";
const SYSTEM_TAB = "system";
const PROJECT_TAB_PREFIX = "project:";

type AgentEditor = { agent?: AgentSummary; builtin?: boolean };
type DeleteTarget =
  | { kind: "agent"; name: string; scope: SubagentSettingsScope }
  | { kind: "chain"; name: string; scope: SubagentSettingsScope };

export function SubagentSettingsPage() {
  const desktopStore = useDesktopStore();
  const catalogProjects = useStore(desktopStore, selectProjects);
  const projects = useMemo(() => catalogProjects.filter(isUserProject), [catalogProjects]);
  const [selectedTab, setSelectedTab] = useState(USER_TAB);
  const activeTab = resolveSubagentSettingsActiveTab(selectedTab, projects);
  const selectedProjectId = activeTab.startsWith(PROJECT_TAB_PREFIX)
    ? activeTab.slice(PROJECT_TAB_PREFIX.length)
    : undefined;
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const systemTab = activeTab === SYSTEM_TAB;
  const scope: SubagentSettingsScope = selectedProjectId ? "project" : "user";
  const controller = useSubagentSettingsController(
    selectedProjectId,
    systemTab ? "system" : selectedProjectId ? "project" : "user",
  );
  const [query, setQuery] = useState("");
  const [agentEditor, setAgentEditor] = useState<AgentEditor>();
  const [chainEditor, setChainEditor] = useState<ChainSummary | null>();
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>();
  const snapshot = controller.snapshot;

  const selectTab = useCallback(
    (value: string): void => {
      if (value.startsWith(PROJECT_TAB_PREFIX)) {
        const projectId = value.slice(PROJECT_TAB_PREFIX.length);
        if (!projects.some((project) => project.id === projectId && project.available)) return;
      }
      setSelectedTab(value);
      setAgentEditor(undefined);
      setChainEditor(undefined);
      setDeleteTarget(undefined);
    },
    [projects],
  );

  useEffect(() => {
    if (activeTab !== selectedTab) selectTab(activeTab);
  }, [activeTab, selectedTab, selectTab]);

  const filtered = useMemo(() => {
    const matches = (value: { name: string; description: string }) =>
      !query.trim() || `${value.name} ${value.description}`.toLowerCase().includes(query.trim().toLowerCase());
    const customAgents = snapshot ? (scope === "project" ? snapshot.projectAgents : snapshot.userAgents) : [];
    const chains = snapshot?.chains.filter((chain) => chain.source === scope) ?? [];
    return snapshot
      ? {
          builtin: snapshot.builtinAgents.filter(matches),
          package: snapshot.packageAgents.filter(matches),
          custom: customAgents.filter(matches),
          chains: chains.filter(matches),
        }
      : { builtin: [], package: [], custom: [], chains: [] };
  }, [query, scope, snapshot]);

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
    <div className="settings-content subagent-settings">
      <header className="settings-page-heading subagent-page-heading">
        <div>
          <h2>子智能体</h2>
          <p>{systemTab ? "系统配置" : selectedProject ? `${selectedProject.name} 项目作用域` : "个人作用域"}</p>
        </div>
        <Button
          variant="outline"
          size="icon"
          title="重新加载"
          disabled={controller.loading || controller.mutating}
          onClick={() => void controller.reload()}
        >
          <RefreshCw className={controller.loading ? "subagent-spin" : undefined} />
        </Button>
      </header>

      <Tabs.Root className="subagent-scope-tabs" value={activeTab} onValueChange={selectTab}>
        <Tabs.List className="subagent-scope-tab-list" aria-label="子智能体配置作用域">
          <Tabs.Trigger value={USER_TAB}>个人</Tabs.Trigger>
          {projects.map((project) => (
            <Tabs.Trigger
              key={project.id}
              value={`${PROJECT_TAB_PREFIX}${project.id}`}
              aria-disabled={!project.available}
              aria-label={
                project.available ? project.name : `${project.name}，不可用：${project.issue ?? "目录不可访问"}`
              }
              title={project.available ? project.cwd : project.issue}
            >
              {project.name}
            </Tabs.Trigger>
          ))}
          <Tabs.Trigger value={SYSTEM_TAB}>系统</Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content className="subagent-scope-tab-content" value={activeTab}>
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
              placeholder={systemTab ? "搜索系统智能体" : "搜索智能体或流程"}
              className="pl-8"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>

          {controller.loading && !snapshot ? <div className="subagent-loading">正在读取配置...</div> : null}

          {snapshot ? (
            <>
              {!systemTab ? (
                <>
                  <section className="settings-section subagent-section" aria-labelledby="custom-agents-heading">
                    <div className="settings-section-heading subagent-section-heading">
                      <h3 id="custom-agents-heading">自定义智能体</h3>
                      <Button size="sm" variant="outline" onClick={() => setAgentEditor({})}>
                        <Plus />
                        新建智能体
                      </Button>
                    </div>
                    {filtered.custom.length ? (
                      filtered.custom.map((agent) => (
                        <SubagentCustomAgentRow
                          key={`${agent.source}:${agent.filePath}`}
                          agent={agent}
                          disabled={controller.mutating}
                          onEdit={() => setAgentEditor({ agent })}
                          onDelete={() => setDeleteTarget({ kind: "agent", name: agent.name, scope })}
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
                          disabled={controller.mutating}
                          onEdit={() => setChainEditor(chain)}
                          onDelete={() => setDeleteTarget({ kind: "chain", name: chain.name, scope })}
                        />
                      ))
                    ) : (
                      <div className="settings-row subagent-empty-row">{query ? "没有匹配的流程" : "暂无流程"}</div>
                    )}
                  </section>
                </>
              ) : (
                <SubagentExtensionConfigPanel
                  key={snapshot.revision}
                  config={snapshot.extensionConfig}
                  saving={controller.mutating}
                  onSave={(config) => controller.mutate({ type: "update-extension-config", config })}
                />
              )}

              {filtered.package.length ? (
                <SubagentAgentSection
                  title="包智能体"
                  agents={filtered.package}
                  mutating={controller.mutating}
                  readOnly
                />
              ) : null}

              <SubagentAgentSection
                title="内置智能体"
                agents={filtered.builtin}
                mutating={controller.mutating}
                defaultCollapsed
                builtin={!systemTab}
                readOnly={systemTab}
                copyLabel={scope === "project" ? "复制到项目" : "复制到个人"}
                onEdit={(agent) => setAgentEditor({ agent, builtin: true })}
                onToggle={(agent, disabled) =>
                  controller.mutate({
                    type: "set-agent-enabled",
                    agent: agent.name,
                    disabled,
                    scope,
                  })
                }
                onEject={(agent) => controller.mutate({ type: "eject-agent", agent: agent.name, scope })}
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

              {!systemTab && agentEditor ? (
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

              {!systemTab && chainEditor !== undefined ? (
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
          ) : null}
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
