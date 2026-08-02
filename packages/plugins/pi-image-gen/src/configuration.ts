import { BUILT_IN_MODELS, DEFAULT_BASE_URL, ENV_VARS, PROVIDER_DISPLAY_NAME } from "./models.ts";
import type { BuiltInProviderId } from "./types.ts";

export type PluginConfigurationValue = string | number | boolean;

interface PluginConfigurationFieldBase {
  key: string;
  label: string;
  description?: string;
  group?: string;
  order?: number;
  deprecated?: boolean;
  deprecatedMessage?: string;
  required?: boolean;
}

export type PluginConfigurationField =
  | (PluginConfigurationFieldBase & {
      type: "text" | "textarea" | "path";
      defaultValue?: string;
      placeholder?: string;
      minLength?: number;
      maxLength?: number;
      pattern?: string;
      patternMessage?: string;
    })
  | (PluginConfigurationFieldBase & {
      type: "secret";
      placeholder?: string;
      minLength?: number;
      maxLength?: number;
      pattern?: string;
      patternMessage?: string;
    })
  | (PluginConfigurationFieldBase & {
      type: "number";
      defaultValue?: number;
      minimum?: number;
      maximum?: number;
      step?: number;
    })
  | (PluginConfigurationFieldBase & { type: "boolean"; defaultValue?: boolean })
  | (PluginConfigurationFieldBase & {
      type: "select";
      defaultValue?: string;
      options: Array<{ value: string; label: string; description?: string }>;
    });

export interface PluginConfigurationSchema {
  version: 1;
  fields: PluginConfigurationField[];
}

const PROVIDER_ORDER: BuiltInProviderId[] = ["openai", "gemini", "dashscope", "ark", "openrouter"];

const MODEL_OPTIONS = BUILT_IN_MODELS.map((model) => ({
  value: model.id,
  label: model.id,
  description: [
    PROVIDER_DISPLAY_NAME[model.provider],
    ...(model.aliases && model.aliases.length > 0 ? [`别名 ${model.aliases.join("、")}`] : []),
  ].join(" · "),
}));

function defaultModelDescription(): string {
  return [
    `内置模型快捷选择，共 ${BUILT_IN_MODELS.length} 个（含别名）。`,
    "使用 OpenRouter 等自定义模型时选择「自定义模型…」并填写下面的自定义模型字段。",
  ].join(" ");
}

function providerFields(provider: BuiltInProviderId, order: number): PluginConfigurationField[] {
  const displayName = PROVIDER_DISPLAY_NAME[provider];
  const defaultUrl = DEFAULT_BASE_URL[provider];
  return [
    {
      key: `${provider}ApiKey`,
      label: "API Key",
      type: "secret",
      group: displayName,
      order,
      placeholder: "输入 API 密钥",
      minLength: 8,
      description: `${displayName} 的 API 密钥，保存后由系统凭据加密存储。留空时回退到环境变量 ${ENV_VARS[provider]}。`,
    },
    {
      key: `${provider}BaseUrl`,
      label: "Base URL",
      type: "text",
      group: displayName,
      order: order + 1,
      placeholder: defaultUrl,
      pattern: "^https?://",
      patternMessage: "必须以 http:// 或 https:// 开头",
      description: `覆盖 ${displayName} 的默认接口地址，默认 ${defaultUrl}。一般无需修改。`,
    },
  ];
}

export const IMAGE_GEN_CONFIGURATION_SCHEMA: PluginConfigurationSchema = {
  version: 1,
  fields: [
    {
      key: "defaultModel",
      label: "默认模型",
      type: "select",
      required: true,
      defaultValue: "gpt-image-2",
      options: [...MODEL_OPTIONS, { value: "custom", label: "自定义模型…" }],
      description: defaultModelDescription(),
      order: 1,
    },
    {
      key: "customModel",
      label: "自定义模型",
      type: "text",
      placeholder: "openrouter/<厂商>/<模型>",
      description:
        "任意模型 ID（如 openrouter/deepseek/deepseek-chat），填写后优先于上面的内置模型选择。需要配置对应提供商的 API Key。",
      order: 2,
    },
    {
      key: "outputDir",
      label: "输出目录",
      type: "path",
      defaultValue: ".pi/images",
      placeholder: ".pi/images",
      description: "生成图片的保存目录，相对于会话工作目录，也可以填绝对路径。",
      order: 3,
    },
    ...PROVIDER_ORDER.flatMap((provider, index) => providerFields(provider, index * 2 + 4)),
  ],
};

export const IMAGE_GEN_CONFIGURATION_SCHEMA_JSON = `${JSON.stringify(IMAGE_GEN_CONFIGURATION_SCHEMA, null, 2)}\n`;
