import type { ModelsConfigMetadata } from "@earendil-works/pi-coding-agent/models-config";
import { Button } from "@renderer/shared/ui/button";
import Settings2 from "lucide-react/dist/esm/icons/settings-2.mjs";
import type { ModelsProviderDraft } from "../../../../shared/models-config-contracts.ts";

interface ModelsProviderOverviewProps {
  provider: ModelsProviderDraft;
  metadata: ModelsConfigMetadata;
  onEdit(): void;
}

export function ModelsProviderOverview({ provider, metadata, onEdit }: ModelsProviderOverviewProps) {
  const builtIn = metadata.builtInProviders.find((item) => item.id === provider.key);
  const modelCount = provider.models.length + provider.modelOverrides.length;
  return (
    <section className="models-overview">
      <div className="models-overview-hero">
        <div className="models-provider-avatar">
          {(provider.config.name || builtIn?.displayName || provider.key).slice(0, 1).toUpperCase()}
        </div>
        <div className="models-overview-heading">
          <span className="models-eyebrow">{builtIn ? "内置 Provider" : "自定义 Provider"}</span>
          <h2>{provider.config.name || builtIn?.displayName || provider.key}</h2>
          <p>
            {provider.key} · {provider.config.api || "未指定 API"}
          </p>
        </div>
        <Button onClick={onEdit}>
          <Settings2 />
          编辑配置
        </Button>
      </div>
      <div className="models-overview-grid">
        <div>
          <span>Base URL</span>
          <strong>{provider.config.baseUrl || "使用默认地址"}</strong>
        </div>
        <div>
          <span>认证方式</span>
          <strong>
            {provider.config.apiKey ? "API key 已配置" : provider.config.oauth ? "OAuth" : "环境变量 / 未设置"}
          </strong>
        </div>
        <div>
          <span>已配置模型</span>
          <strong>{modelCount} 个</strong>
        </div>
      </div>
      <div className="models-overview-models">
        <div className="models-section-heading">
          <div>
            <h3>模型</h3>
            <p>在编辑配置中管理自定义模型与覆盖。</p>
          </div>
        </div>
        {provider.models.length > 0 ? (
          provider.models.slice(0, 5).map((model) => (
            <div className="models-overview-model" key={model.config.id}>
              <span>{model.config.name || model.config.id}</span>
              <small>{model.config.id}</small>
            </div>
          ))
        ) : (
          <div className="models-overview-empty">暂无自定义模型，使用内置模型或点击编辑配置添加。</div>
        )}
      </div>
    </section>
  );
}
