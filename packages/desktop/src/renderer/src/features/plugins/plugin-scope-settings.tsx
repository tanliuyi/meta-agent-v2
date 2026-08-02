import { GENERAL_WORKSPACE_ID, type Project } from "../../../../shared/contracts.ts";
import type { ExtensionScope } from "../../../../shared/desktop-extension-contracts.ts";

interface PluginScopeSettingsProps {
  pluginId: string;
  scope: ExtensionScope;
  projectIds: readonly string[];
  projects: readonly Project[];
  mutationPending: boolean;
  onSetScope(scope: ExtensionScope, projectIds?: string[]): void;
}

/** 已安装插件的生效范围配置：全部项目或指定的一个或多个项目。市场插件与本地插件共用。 */
export function PluginScopeSettings({
  pluginId,
  scope,
  projectIds,
  projects,
  mutationPending,
  onSetScope,
}: PluginScopeSettingsProps) {
  const availableProjects = projects.filter((project) => project.available);
  const missingBoundProjectIds = projectIds.filter(
    (projectId) => !projects.some((project) => project.id === projectId),
  );
  const selectProjectScope = () => {
    const target = availableProjects.find((project) => projectIds.includes(project.id)) ?? availableProjects[0];
    if (target) onSetScope("project", [target.id]);
  };
  const toggleProject = (projectId: string, checked: boolean) => {
    if (checked) {
      onSetScope("project", [...projectIds, projectId]);
      return;
    }
    const next = projectIds.filter((id) => id !== projectId);
    // 取消最后一个绑定项目等同于不再限定：切回全部项目。
    onSetScope(next.length === 0 ? "global" : "project", next.length === 0 ? undefined : next);
  };

  return (
    <section className="plugin-marketplace-detail-section" aria-labelledby="plugin-detail-scope">
      <h3 id="plugin-detail-scope">作用域</h3>
      <p>插件对全部项目生效，或仅对选定的一个或多个项目生效。</p>
      <div className="plugin-marketplace-scope-options" role="radiogroup" aria-label="插件作用域">
        <label className="plugin-marketplace-scope-option" data-selected={scope === "global" || undefined}>
          <input
            type="radio"
            name={`plugin-scope-${pluginId}`}
            checked={scope === "global"}
            disabled={mutationPending}
            onChange={() => onSetScope("global")}
          />
          <span>
            <strong>全部项目</strong>
            <span>所有项目的会话均可加载此插件</span>
          </span>
        </label>
        <label className="plugin-marketplace-scope-option" data-selected={scope === "project" || undefined}>
          <input
            type="radio"
            name={`plugin-scope-${pluginId}`}
            checked={scope === "project"}
            disabled={mutationPending || availableProjects.length === 0}
            title={availableProjects.length === 0 ? "没有可用的项目，无法限定到指定项目" : undefined}
            onChange={selectProjectScope}
          />
          <span>
            <strong>指定项目</strong>
            <span>仅所选项目的会话可加载此插件</span>
          </span>
        </label>
      </div>
      {scope === "project" ? (
        <div className="plugin-marketplace-scope-projects" role="group" aria-label="插件生效的项目">
          {projects.map((project) => {
            const checked = projectIds.includes(project.id);
            return (
              <label className="plugin-marketplace-scope-project" data-selected={checked || undefined} key={project.id}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={mutationPending || !project.available}
                  title={!project.available ? "该项目当前不可用" : undefined}
                  onChange={(event) => toggleProject(project.id, event.currentTarget.checked)}
                />
                <span>{project.id === GENERAL_WORKSPACE_ID ? "对话" : project.name}</span>
                {!project.available ? <span className="plugin-marketplace-scope-warning">不可用</span> : null}
              </label>
            );
          })}
          {missingBoundProjectIds.length > 0 ? (
            <span className="plugin-marketplace-scope-warning" role="status">
              绑定的项目已不存在（{missingBoundProjectIds.join("、")}），可重新选择或改回全部项目
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
