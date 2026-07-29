import { Button } from "@renderer/shared/ui/button";
import Save from "lucide-react/dist/esm/icons/save.mjs";
import { PluginConfigurationFieldControl } from "./plugin-configuration-field-control.tsx";
import { usePluginConfiguration } from "./use-plugin-configuration.ts";

export function PluginConfigurationForm({ pluginId }: { pluginId: string }) {
  const controller = usePluginConfiguration(pluginId);
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
  return (
    <section className="plugin-marketplace-detail-section" aria-labelledby="plugin-detail-configuration">
      <div className="plugin-configuration-heading">
        <div>
          <h3 id="plugin-detail-configuration">配置</h3>
          <span>保存后，新启动或重新加载的会话会使用这些值。</span>
        </div>
        <Button disabled={!controller.dirty || controller.saving} onClick={() => void controller.save()}>
          <Save />
          {controller.saving ? "保存中" : "保存"}
        </Button>
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
      <div className="plugin-configuration-fields">
        {controller.snapshot.schema.fields.map((field) => (
          <PluginConfigurationFieldControl key={field.key} field={field} controller={controller} />
        ))}
      </div>
    </section>
  );
}
