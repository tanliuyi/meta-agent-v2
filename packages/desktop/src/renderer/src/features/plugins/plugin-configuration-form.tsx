import { Button } from "@renderer/shared/ui/button";
import { useToast } from "@renderer/shared/ui/use-toast";
import Braces from "lucide-react/dist/esm/icons/braces.mjs";
import Save from "lucide-react/dist/esm/icons/save.mjs";
import { Fragment, useEffect, useState } from "react";
import type { PluginConfigurationField } from "../../../../shared/plugin-configuration-contracts.ts";
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
  const toast = useToast();
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonSaveRequest, setJsonSaveRequest] = useState(0);

  useEffect(() => {
    if (controller.notice) toast.notify({ message: controller.notice, tone: "success" });
  }, [controller.notice, toast]);

  useEffect(() => {
    // 载入失败（无快照）保留页面内联提示；仅提交类错误以 toast 弹层展示
    if (controller.error && controller.snapshot) toast.notify({ message: controller.error, tone: "error" });
  }, [controller.error, controller.snapshot, toast]);

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
  const segments: Array<{ group: string | undefined; fields: PluginConfigurationField[] }> = [];
  for (const field of sortedFields) {
    const segment = segments[segments.length - 1];
    if (segment !== undefined && segment.group === field.group) {
      segment.fields.push(field);
    } else {
      segments.push({ group: field.group, fields: [field] });
    }
  }
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
      {jsonMode ? (
        <PluginConfigurationJsonEditor controller={controller} saveRequest={jsonSaveRequest} />
      ) : (
        <div className="plugin-configuration-fields">
          {segments.map((segment) => {
            const key = segment.fields[0].key;
            const controls = segment.fields.map((field) => (
              <PluginConfigurationFieldControl key={field.key} field={field} controller={controller} />
            ));
            return segment.group === undefined ? (
              <Fragment key={key}>{controls}</Fragment>
            ) : (
              <div className="plugin-configuration-group" key={key}>
                <h4 className="plugin-configuration-group-heading">{segment.group}</h4>
                {controls}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
