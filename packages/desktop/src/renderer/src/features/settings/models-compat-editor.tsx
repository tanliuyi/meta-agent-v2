import { Button } from "@renderer/shared/ui/button";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import { useRef, useState } from "react";
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
  const valueRef = useRef<ModelsCompatDraft | undefined>(value ? structuredClone(value) : undefined);
  const [draft, setDraft] = useState(valueRef.current);

  const emit = (next: ModelsCompatDraft | undefined, render = true): void => {
    valueRef.current = next;
    if (render) setDraft(next);
    onChange(next);
  };

  if (!draft) {
    return (
      <div className="models-optional-editor">
        <span>兼容性覆盖</span>
        <Button size="sm" variant="outline" onClick={() => emit({ config: {} })}>
          <Plus />
          添加兼容性配置
        </Button>
      </div>
    );
  }

  const updateConfig = (config: CompatConfig, render = true): void => emit({ ...valueRef.current!, config }, render);
  return (
    <fieldset className="models-fieldset models-compat-editor">
      <legend>兼容性</legend>
      <div className="models-compat-grid">
        {BOOLEAN_FIELDS.map((field) => (
          <label key={field}>
            <span>{field}</span>
            <ModelsOptionSelect
              value={draft.config[field] === undefined ? "unset" : String(draft.config[field])}
              onValueChange={(nextValue) =>
                updateConfig(setOptionalBoolean(valueRef.current!.config, field, nextValue))
              }
              options={TRI_STATE_OPTIONS}
            />
          </label>
        ))}
        <label>
          <span>maxTokensField</span>
          <ModelsOptionSelect
            value={draft.config.maxTokensField ?? "unset"}
            onValueChange={(nextValue) =>
              updateConfig(
                setOptionalString(valueRef.current!.config, "maxTokensField", nextValue === "unset" ? "" : nextValue),
              )
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
            value={draft.config.thinkingFormat ?? "unset"}
            onValueChange={(nextValue) =>
              updateConfig(
                setOptionalString(valueRef.current!.config, "thinkingFormat", nextValue === "unset" ? "" : nextValue),
              )
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
            value={draft.config.cacheControlFormat ?? "unset"}
            onValueChange={(nextValue) =>
              updateConfig(
                setOptionalString(
                  valueRef.current!.config,
                  "cacheControlFormat",
                  nextValue === "unset" ? "" : nextValue,
                ),
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
            value={draft.config.sessionAffinityFormat ?? "unset"}
            onValueChange={(nextValue) =>
              updateConfig(
                setOptionalString(
                  valueRef.current!.config,
                  "sessionAffinityFormat",
                  nextValue === "unset" ? "" : nextValue,
                ),
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
        entries={draft.chatTemplateKwargs ?? []}
        onChange={(chatTemplateKwargs) => emit({ ...valueRef.current!, chatTemplateKwargs }, false)}
      />
      <div className="models-compat-routing">
        <ModelsOpenRouterEditor
          value={draft.config.openRouterRouting}
          onChange={(openRouterRouting) =>
            updateConfig(setOptionalObject(valueRef.current!.config, "openRouterRouting", openRouterRouting), false)
          }
        />
        <ModelsVercelRoutingEditor
          value={draft.config.vercelGatewayRouting}
          onChange={(vercelGatewayRouting) =>
            updateConfig(
              setOptionalObject(valueRef.current!.config, "vercelGatewayRouting", vercelGatewayRouting),
              false,
            )
          }
        />
      </div>
      <div className="models-compat-footer">
        <Button size="sm" variant="ghost" onClick={() => emit(undefined)}>
          清除兼容性配置
        </Button>
      </div>
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
