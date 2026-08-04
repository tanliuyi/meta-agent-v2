import { Button } from "@renderer/shared/ui/button";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import { useRef, useState } from "react";
import type { ModelsCompatDraft } from "../../../../../shared/models-config-contracts.ts";
import { ModelsChatTemplateEditor } from "./models-chat-template-editor.tsx";
import { ModelsOpenRouterEditor } from "./models-openrouter-editor.tsx";
import { ModelsOptionSelect } from "./models-option-select.tsx";
import { ModelsVercelRoutingEditor } from "./models-vercel-routing-editor.tsx";

interface ModelsCompatEditorProps {
  value?: ModelsCompatDraft;
  onChange(value: ModelsCompatDraft | undefined): void;
}

const BOOLEAN_FIELDS = [
  {
    key: "supportsStore",
    label: "支持 store 字段",
    hint: "是否支持 OpenAI 的 store 请求字段。默认按 Base URL 自动检测",
  },
  {
    key: "supportsDeveloperRole",
    label: "支持 developer 角色",
    hint: "系统提示使用 developer 角色发送，而不是 system",
  },
  {
    key: "supportsReasoningEffort",
    label: "支持推理强度参数",
    hint: "是否支持 reasoning_effort 请求参数",
  },
  {
    key: "supportsUsageInStreaming",
    label: "流式返回用量",
    hint: "流式响应中通过 stream_options 返回 token 用量统计",
  },
  {
    key: "requiresToolResultName",
    label: "工具结果需 name 字段",
    hint: "工具结果消息必须携带 name 字段",
  },
  {
    key: "requiresAssistantAfterToolResult",
    label: "工具结果后需助手消息",
    hint: "工具结果与下一条用户消息之间需要插入一条 assistant 消息",
  },
  {
    key: "requiresThinkingAsText",
    label: "思考内容转为文本",
    hint: "思考块转换成 <thinking> 文本块后再发送",
  },
  {
    key: "requiresReasoningContentOnAssistantMessages",
    label: "助手消息需 reasoning_content",
    hint: "启用推理时，回放的 assistant 消息必须带空的 reasoning_content 字段",
  },
  {
    key: "supportsOpenAIGrammarTools",
    label: "支持 OpenAI grammar 工具",
    hint: "工具定义是否支持 OpenAI grammar 格式",
  },
  {
    key: "supportsStrictMode",
    label: "支持 strict 模式",
    hint: "工具定义是否支持 strict 字段",
  },
  {
    key: "sendSessionAffinityHeaders",
    label: "发送会话亲和请求头",
    hint: "把请求路由到同一副本以提升提示词缓存命中率",
  },
  {
    key: "supportsLongCacheRetention",
    label: "支持长时效缓存",
    hint: "支持 24 小时 / 1 小时的长时效提示词缓存",
  },
  {
    key: "supportsToolSearch",
    label: "支持工具搜索",
    hint: "模型支持对延迟加载工具做客户端工具搜索",
  },
  {
    key: "supportsEagerToolInputStreaming",
    label: "支持工具输入即时流式",
    hint: "Anthropic 逐工具 eager_input_streaming；关闭时改用旧版 beta 请求头",
  },
  {
    key: "supportsCacheControlOnTools",
    label: "工具上支持缓存标记",
    hint: "工具定义支持 cache_control 标记；部分兼容服务（如 Fireworks）不支持",
  },
  {
    key: "supportsTemperature",
    label: "支持 temperature 参数",
    hint: "是否接受 temperature 请求字段；Claude Opus 4.7+ 会拒绝非默认值",
  },
  {
    key: "forceAdaptiveThinking",
    label: "强制自适应思考",
    hint: "忽略模型 ID 检测，一律使用 adaptive thinking 请求格式",
  },
  {
    key: "allowEmptySignature",
    label: "允许空思考签名",
    hint: '思考签名为空时按 signature: "" 回放，而不是转成文本',
  },
  {
    key: "supportsStrictTools",
    label: "支持严格工具定义",
    hint: "Anthropic 工具定义是否支持 strict 字段",
  },
  {
    key: "supportsToolReferences",
    label: "支持工具引用",
    hint: "支持通过工具结果中的 tool_reference 块加载延迟工具",
  },
] as const;

const TRI_STATE_OPTIONS = [
  { value: "unset", label: "未设置" },
  { value: "true", label: "是" },
  { value: "false", label: "否" },
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
        {BOOLEAN_FIELDS.map(({ key, label, hint }) => (
          <label key={key}>
            <span>{label}</span>
            <ModelsOptionSelect
              value={draft.config[key] === undefined ? "unset" : String(draft.config[key])}
              onValueChange={(nextValue) => updateConfig(setOptionalBoolean(valueRef.current!.config, key, nextValue))}
              options={TRI_STATE_OPTIONS}
            />
            <small>{hint}</small>
          </label>
        ))}
        <label>
          <span>最大 token 字段名</span>
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
          <small>请求中携带最大输出 token 数所用的字段名。默认按 Base URL 自动检测</small>
        </label>
        <label>
          <span>思考参数格式</span>
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
          <small>思考 / 推理参数的请求格式，不同服务商各不相同。默认 openai</small>
        </label>
        <label>
          <span>缓存标记格式</span>
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
          <small>提示词缓存标记的风格。anthropic 表示按 Anthropic 风格打 cache_control 标记</small>
        </label>
        <label>
          <span>会话亲和头格式</span>
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
          <small>会话亲和请求头的发送格式。默认按 Base URL 自动检测</small>
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
