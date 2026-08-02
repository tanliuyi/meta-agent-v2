import { Button } from "@renderer/shared/ui/button";
import Braces from "lucide-react/dist/esm/icons/braces.mjs";
import Save from "lucide-react/dist/esm/icons/save.mjs";
import { Fragment, useState } from "react";
import { PluginConfigurationFieldControl } from "./plugin-configuration-field-control.tsx";
import { PluginConfigurationJsonEditor } from "./plugin-configuration-json-editor.tsx";
import type { PluginConfigurationSource } from "./use-plugin-configuration.ts";
import { usePluginConfiguration } from "./use-plugin-configuration.ts";

export function PluginConfigurationForm({
  pluginId,
  source = "marketplace",
}: {
  pluginId: string;
  source?: PluginConfigurationSource;
}) {
  const controller = usePluginConfiguration(pluginId, source);
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonSaveRequest, setJsonSaveRequest] = useState(0);
  if (controller.loading) {
    return (
      <section className="plugin-marketplace-detail-section" aria-labelledby="plugin-detail-configuration">
        <h3 id="plugin-detail-configuration">配置</h3>
        <span className="plugin-marketplace-detail-muted" role="status">
          正在载入配置
        </span>
      </section>
    );
  }
  if (!controller.snapshot) {
    return (
      <section className="plugin-marketplace-detail-section" aria-labelledby="plugin-detail-configuration">
        <h3 id="plugin-detail-configuration">配置</h3>
        <div className="plugin-configuration-message" data-tone="error" role="alert">
          {controller.error ?? "无法载入插件配置"}
        </div>
      </section>
    );
  }
  const sortedFields = [...controller.snapshot.schema.fields].sort(
    (a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER),
  );
  const seenGroups = new Set<string>();
  return (
    <section className="plugin-marketplace-detail-section" aria-labelledby="plugin-detail-configuration">
      <div className="plugin-configuration-heading">
        <div>
          <h3 id="plugin-detail-configuration">配置</h3>
          <span>保存后，新启动或重新加载的会话会使用这些值。</span>
        </div>
        <div className="plugin-configuration-heading-actions">
          <Button
            variant="ghost"
            aria-pressed={jsonMode}
            aria-label={jsonMode ? "切换到表单编辑模式" : "切换到 JSON 编辑模式"}
            title={jsonMode ? "切换到表单编辑模式" : "切换到 JSON 编辑模式"}
            onClick={() => setJsonMode((current) => !current)}
          >
            <Braces />
            {jsonMode ? "表单" : "JSON"}
          </Button>
          <Button
            disabled={controller.saving || (!jsonMode && !controller.dirty)}
            onClick={() => (jsonMode ? setJsonSaveRequest((request) => request + 1) : void controller.save())}
          >
            <Save />
            {controller.saving ? "保存中" : "保存"}
          </Button>
        </div>
      </div>
      {controller.error ? (
        <div className="plugin-configuration-message" data-tone="error" role="alert">
          {controller.error}
        </div>
      ) : null}
      {controller.notice ? (
        <div className="plugin-configuration-message" data-tone="success" role="status">
          {controller.notice}
        </div>
      ) : null}
      {jsonMode ? (
        <PluginConfigurationJsonEditor controller={controller} saveRequest={jsonSaveRequest} />
      ) : (
        <div className="plugin-configuration-fields">
          {sortedFields.map((field) => {
            const heading = field.group !== undefined && !seenGroups.has(field.group) ? field.group : undefined;
            if (field.group !== undefined) seenGroups.add(field.group);
            return (
              <Fragment key={field.key}>
                {heading !== undefined ? <h4 className="plugin-configuration-group-heading">{heading}</h4> : null}
                <PluginConfigurationFieldControl field={field} controller={controller} />
              </Fragment>
            );
          })}
        </div>
      )}
    </section>
  );
}
