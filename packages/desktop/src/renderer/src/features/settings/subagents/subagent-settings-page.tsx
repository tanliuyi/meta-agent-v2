import { Button } from "@renderer/shared/ui/button";
import { Input } from "@renderer/shared/ui/input";
import { Tabs } from "@renderer/shared/ui/tabs";
import { TabsContent } from "@renderer/shared/ui/tabs-content";
import { TabsList } from "@renderer/shared/ui/tabs-list";
import { TabsTrigger } from "@renderer/shared/ui/tabs-trigger";
import { useToast } from "@renderer/shared/ui/use-toast";
import { selectProjects } from "@renderer/state/desktop-selectors";
import { useDesktopStore } from "@renderer/state/desktop-store-context";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import type {
  AgentSummary,
  ChainSummary,
  SubagentSettingsMutation,
  SubagentSettingsScope,
} from "../../../../../shared/subagent-contracts.ts";
import { builtinSubagentDisplayName } from "../../../shared/lib/builtin-subagent-name.ts";
import { SubagentAgentSection } from "./subagent-agent-section.tsx";
import { SubagentChainRow } from "./subagent-chain-row.tsx";
import { SubagentCustomAgentRow } from "./subagent-custom-agent-row.tsx";
import { SubagentExtensionConfigPanel } from "./subagent-extension-config-panel.tsx";
import { SubagentSettingsDialogs, type SubagentSettingsDialogsHandle } from "./subagent-settings-dialogs.tsx";
import { SubagentWatchdogPanel } from "./subagent-watchdog-panel.tsx";
import { resolveSubagentSettingsActiveTab, useSubagentSettingsController } from "./use-subagent-settings-controller.ts";

const USER_TAB = "user";
const SYSTEM_TAB = "system";
const PROJECT_TAB_PREFIX = "project:";

export function SubagentSettingsPage() {
  const desktopStore = useDesktopStore();
  const projects = useStore(desktopStore, selectProjects);
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
  const toast = useToast();
  const notifyMutation = useCallback(
    async (mutation: SubagentSettingsMutation, successMessage: string): Promise<boolean> => {
      const failure = await controller.mutate(mutation);
      if (failure === undefined) {
        toast.notify({ message: successMessage, tone: "success" });
        return true;
      }
      toast.notify({ message: failure, tone: "error" });
      return false;
    },
    [controller, toast],
  );
  const dialogsRef = useRef<SubagentSettingsDialogsHandle>(null);
  const [query, setQuery] = useState("");
  const snapshot = controller.snapshot;

  const selectTab = useCallback(
    (value: string): void => {
      if (value.startsWith(PROJECT_TAB_PREFIX)) {
        const projectId = value.slice(PROJECT_TAB_PREFIX.length);
        if (!projects.some((project) => project.id === projectId && project.available)) return;
      }
      setSelectedTab(value);
      dialogsRef.current?.close();
    },
    [projects],
  );

  useEffect(() => {
    if (activeTab !== selectedTab) selectTab(activeTab);
  }, [activeTab, selectedTab, selectTab]);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const matches = (value: { name: string; description: string }, localizedName = value.name) =>
      !normalizedQuery || `${value.name} ${localizedName} ${value.description}`.toLowerCase().includes(normalizedQuery);
    const customAgents = snapshot ? (scope === "project" ? snapshot.projectAgents : snapshot.userAgents) : [];
    const chains = snapshot?.chains.filter((chain) => chain.source === scope) ?? [];
    return snapshot
      ? {
          builtin: snapshot.builtinAgents.filter((agent) => matches(agent, builtinSubagentDisplayName(agent.name))),
          package: snapshot.packageAgents.filter((agent) => matches(agent)),
          custom: customAgents.filter((agent) => matches(agent)),
          chains: chains.filter((chain) => matches(chain)),
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

      <Tabs className="subagent-scope-tabs" value={activeTab} onValueChange={selectTab}>
        <TabsList className="subagent-scope-tab-list" aria-label="子智能体配置作用域">
          <TabsTrigger value={USER_TAB}>个人</TabsTrigger>
          {projects.map((project) => (
            <TabsTrigger
              key={project.id}
              value={`${PROJECT_TAB_PREFIX}${project.id}`}
              aria-disabled={!project.available}
              aria-label={
                project.available ? project.name : `${project.name}，不可用：${project.issue ?? "目录不可访问"}`
              }
              title={project.available ? project.cwd : project.issue}
            >
              {project.name}
            </TabsTrigger>
          ))}
          <TabsTrigger value={SYSTEM_TAB}>系统</TabsTrigger>
        </TabsList>

        <TabsContent className="subagent-scope-tab-content" value={activeTab}>
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
                  <SubagentWatchdogPanel
                    key={`watchdog:${snapshot.revision}`}
                    settings={snapshot.watchdog}
                    models={snapshot.models}
                    scopeLabel={scope === "project" ? "项目" : "个人"}
                    saving={controller.mutating}
                    onSave={(config) =>
                      notifyMutation({ type: "update-watchdog-config", scope, config }, "看门狗配置已保存")
                    }
                  />
                  <section className="settings-section subagent-section" aria-labelledby="custom-agents-heading">
                    <div className="settings-section-heading subagent-section-heading">
                      <h3 id="custom-agents-heading">自定义智能体</h3>
                      <Button size="sm" variant="outline" onClick={() => dialogsRef.current?.openAgent()}>
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
                          onEdit={() => dialogsRef.current?.openAgent(agent)}
                          onDelete={() => dialogsRef.current?.requestDelete({ kind: "agent", name: agent.name, scope })}
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
                      <Button size="sm" variant="outline" onClick={() => dialogsRef.current?.openChain()}>
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
                          onEdit={() => dialogsRef.current?.openChain(chain)}
                          onDelete={() => dialogsRef.current?.requestDelete({ kind: "chain", name: chain.name, scope })}
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
                  onSave={(config) => notifyMutation({ type: "update-extension-config", config }, "扩展配置已保存")}
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
                onEdit={(agent) => dialogsRef.current?.openAgent(agent, true)}
                onToggle={(agent, disabled) =>
                  notifyMutation(
                    { type: "set-agent-enabled", agent: agent.name, disabled, scope },
                    `${agent.name}${disabled ? "已禁用" : "已启用"}`,
                  )
                }
                onEject={(agent) =>
                  notifyMutation({ type: "eject-agent", agent: agent.name, scope }, "已弹出为自定义智能体")
                }
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
            </>
          ) : null}
        </TabsContent>
      </Tabs>
      <SubagentSettingsDialogs
        ref={dialogsRef}
        allAgents={allAgents}
        controller={controller}
        notifyMutation={notifyMutation}
        scope={scope}
        snapshot={snapshot}
        systemTab={systemTab}
      />
    </div>
  );
}
