import type { ProviderBuiltInModelMetadata } from "../../../../shared/providers-config-contracts.ts";
import { ProviderBuiltInMetadataSection } from "./provider-built-in-metadata-section.tsx";
import { ProviderBuiltInModelValue } from "./provider-built-in-model-value.tsx";

interface ProviderBuiltInModelDetailProps {
  model: ProviderBuiltInModelMetadata;
}

/** Read-only projection of a built-in model's effective catalog configuration. */
export function ProviderBuiltInModelDetail({ model }: ProviderBuiltInModelDetailProps) {
  return (
    <div className="providers-builtin-model-detail">
      <header className="providers-builtin-model-header">
        <div>
          <span>内置模型</span>
          <h3>{model.name}</h3>
          <code>{model.id}</code>
        </div>
        <span className="providers-builtin-model-api">{model.api}</span>
      </header>

      <fieldset className="models-fieldset providers-builtin-model-section">
        <legend>基础配置</legend>
        <dl className="providers-builtin-model-grid">
          <ProviderBuiltInModelValue label="模型 ID" value={model.id} code />
          <ProviderBuiltInModelValue label="显示名称" value={model.name} />
          <ProviderBuiltInModelValue label="API 类型" value={model.api} code />
          <ProviderBuiltInModelValue label="Base URL" value={model.baseUrl ?? "继承 Provider"} code />
          <ProviderBuiltInModelValue label="上下文窗口" value={formatOptionalNumber(model.contextWindow)} />
          <ProviderBuiltInModelValue label="最大输出 tokens" value={formatOptionalNumber(model.maxTokens)} />
          <ProviderBuiltInModelValue
            label="推理能力"
            value={model.reasoning === undefined ? "继承 Provider" : model.reasoning ? "支持" : "不支持"}
          />
          <ProviderBuiltInModelValue label="输入类型" value={model.input?.join("、") ?? "继承 Provider"} />
        </dl>
      </fieldset>

      <fieldset className="models-fieldset providers-builtin-model-section">
        <legend>费用（每百万 tokens）</legend>
        {model.cost ? (
          <>
            <dl className="providers-builtin-model-grid providers-builtin-model-grid--compact">
              <ProviderBuiltInModelValue label="输入" value={formatCost(model.cost.input)} />
              <ProviderBuiltInModelValue label="输出" value={formatCost(model.cost.output)} />
              <ProviderBuiltInModelValue label="缓存读取" value={formatCost(model.cost.cacheRead)} />
              <ProviderBuiltInModelValue label="缓存写入" value={formatCost(model.cost.cacheWrite)} />
            </dl>
            {model.cost.tiers?.length ? (
              <div className="providers-builtin-model-records">
                {model.cost.tiers.map((tier) => (
                  <code key={tier.inputTokensAbove}>
                    {`>${formatNumber(tier.inputTokensAbove)} tokens: input ${formatCost(tier.input)}, output ${formatCost(tier.output)}, cache read ${formatCost(tier.cacheRead)}, cache write ${formatCost(tier.cacheWrite)}`}
                  </code>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <p className="providers-builtin-model-empty">继承 Provider</p>
        )}
      </fieldset>

      <ProviderBuiltInMetadataSection title="思考等级映射" value={model.thinkingLevelMap} />
      <ProviderBuiltInMetadataSection title="请求头" value={model.headers} />
      <ProviderBuiltInMetadataSection title="兼容性" value={model.compat} />
    </div>
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatOptionalNumber(value: number | undefined): string {
  return value === undefined ? "继承 Provider" : formatNumber(value);
}

function formatCost(value: number): string {
  return `$${value}`;
}
