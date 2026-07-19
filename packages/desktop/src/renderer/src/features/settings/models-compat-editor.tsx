import { Button } from "@renderer/shared/ui/button";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import type { ModelsCompatDraft } from "../../../../shared/models-config-contracts.ts";
import { ModelsChatTemplateEditor } from "./models-chat-template-editor.tsx";
import { ModelsOpenRouterEditor } from "./models-openrouter-editor.tsx";
import { ModelsOptionSelect } from "./models-option-select.tsx";
import { ModelsVercelRoutingEditor } from "./models-vercel-routing-editor.tsx";

interface ModelsCompatEditorProps {
  value?: ModelsCompatDraft;
  onChange(value: ModelsCompatDraft | undefined): void;
}

const BOOLEAN_FIELDS = [
  "supportsStore",
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "supportsUsageInStreaming",
  "requiresToolResultName",
  "requiresAssistantAfterToolResult",
  "requiresThinkingAsText",
  "requiresReasoningContentOnAssistantMessages",
  "zaiToolStream",
  "supportsStrictMode",
  "sendSessionAffinityHeaders",
  "supportsLongCacheRetention",
  "supportsToolSearch",
  "supportsEagerToolInputStreaming",
  "supportsCacheControlOnTools",
  "supportsTemperature",
  "forceAdaptiveThinking",
  "allowEmptySignature",
  "supportsToolReferences",
] as const;

const TRI_STATE_OPTIONS = [
  { value: "unset", label: "未设置" },
  { value: "true", label: "true" },
  { value: "false", label: "false" },
] as const;

type CompatConfig = ModelsCompatDraft["config"];

/** Covers every current compat field with typed shadcn controls rather than a JSON editor. */
export function ModelsCompatEditor({ value, onChange }: ModelsCompatEditorProps) {
  if (!value) {
    return (
      <div className="models-optional-editor">
        <span>兼容性覆盖</span>
        <Button size="sm" variant="outline" onClick={() => onChange({ config: {} })}>
          <Plus />
          添加兼容性配置
        </Button>
      </div>
    );
  }

  const updateConfig = (config: CompatConfig) => onChange({ ...value, config });
  return (
    <fieldset className="models-fieldset models-compat-editor">
      <legend>兼容性</legend>
      <div className="models-compat-grid">
        {BOOLEAN_FIELDS.map((field) => (
          <label key={field}>
            <span>{field}</span>
            <ModelsOptionSelect
              value={value.config[field] === undefined ? "unset" : String(value.config[field])}
              onValueChange={(nextValue) => updateConfig(setOptionalBoolean(value.config, field, nextValue))}
              options={TRI_STATE_OPTIONS}
            />
          </label>
        ))}
        <label>
          <span>maxTokensField</span>
          <ModelsOptionSelect
            value={value.config.maxTokensField ?? "unset"}
            onValueChange={(nextValue) =>
              updateConfig(setOptionalString(value.config, "maxTokensField", nextValue === "unset" ? "" : nextValue))
            }
            options={[
              { value: "unset", label: "未设置" },
              { value: "max_completion_tokens", label: "max_completion_tokens" },
              { value: "max_tokens", label: "max_tokens" },
            ]}
          />
        </label>
        <label>
          <span>thinkingFormat</span>
          <ModelsOptionSelect
            value={value.config.thinkingFormat ?? "unset"}
            onValueChange={(nextValue) =>
              updateConfig(setOptionalString(value.config, "thinkingFormat", nextValue === "unset" ? "" : nextValue))
            }
            options={[
              { value: "unset", label: "未设置" },
              ...[
                "openai",
                "openrouter",
                "together",
                "deepseek",
                "zai",
                "qwen",
                "chat-template",
                "qwen-chat-template",
                "string-thinking",
                "ant-ling",
              ].map((option) => ({ value: option, label: option })),
            ]}
          />
        </label>
        <label>
          <span>cacheControlFormat</span>
          <ModelsOptionSelect
            value={value.config.cacheControlFormat ?? "unset"}
            onValueChange={(nextValue) =>
              updateConfig(
                setOptionalString(value.config, "cacheControlFormat", nextValue === "unset" ? "" : nextValue),
              )
            }
            options={[
              { value: "unset", label: "未设置" },
              { value: "anthropic", label: "anthropic" },
            ]}
          />
        </label>
        <label>
          <span>sessionAffinityFormat</span>
          <ModelsOptionSelect
            value={value.config.sessionAffinityFormat ?? "unset"}
            onValueChange={(nextValue) =>
              updateConfig(
                setOptionalString(value.config, "sessionAffinityFormat", nextValue === "unset" ? "" : nextValue),
              )
            }
            options={[
              { value: "unset", label: "未设置" },
              { value: "openai", label: "openai" },
              { value: "openai-nosession", label: "openai-nosession" },
              { value: "openrouter", label: "openrouter" },
            ]}
          />
        </label>
      </div>
      <ModelsChatTemplateEditor
        entries={value.chatTemplateKwargs ?? []}
        onChange={(chatTemplateKwargs) => onChange({ ...value, chatTemplateKwargs })}
      />
      <ModelsOpenRouterEditor
        value={value.config.openRouterRouting}
        onChange={(openRouterRouting) =>
          updateConfig(setOptionalObject(value.config, "openRouterRouting", openRouterRouting))
        }
      />
      <ModelsVercelRoutingEditor
        value={value.config.vercelGatewayRouting}
        onChange={(vercelGatewayRouting) =>
          updateConfig(setOptionalObject(value.config, "vercelGatewayRouting", vercelGatewayRouting))
        }
      />
      <Button size="sm" variant="ghost" onClick={() => onChange(undefined)}>
        清除兼容性配置
      </Button>
    </fieldset>
  );
}

function setOptionalBoolean<T extends object, K extends keyof T>(value: T, key: K, input: string): T {
  const next = { ...value };
  if (input === "unset") delete next[key];
  else next[key] = (input === "true") as T[K];
  return next;
}

function setOptionalString<T extends object, K extends keyof T>(value: T, key: K, input: string): T {
  const next = { ...value };
  if (!input) delete next[key];
  else next[key] = input as T[K];
  return next;
}

function setOptionalObject<T extends object, K extends keyof T>(value: T, key: K, input: T[K] | undefined): T {
  const next = { ...value };
  if (input === undefined) delete next[key];
  else next[key] = input;
  return next;
}
