import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type PluginConfigurationValue = string | number | boolean;

export type BrowserOpenTarget = "builtin" | "system";

const RUN_CODE_TOOL_NAMES = {
  webSearch: "web_search",
  sourceCheck: "source_check",
  fetchContent: "fetch_content",
  getSearchContent: "get_search_content",
} as const;

interface PluginConfigurationFieldBase {
  key: string;
  label: string;
  description?: string;
  group?: string;
  order?: number;
  deprecated?: boolean;
  deprecatedMessage?: string;
  required?: boolean;
  widget?: "model-selector";
  modelFormat?: "model-id" | "provider-model";
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

/**
 * Desktop 配置表单的扁平取值（key 与 schema 字段一致，嵌套字段用点号 key，
 * 与上游 ~/.pi/web-search.json 的嵌套结构在 applyDesktopConfig 中互相映射）。
 */
export interface DesktopWebAccessConfig {
  searchProvider?: string;
  searchModel?: string;
  summaryModel?: string;
  workflow?: string;
  curatorTimeoutSeconds?: number;
  autoOpenBrowser?: boolean;
  "browser.openTarget"?: BrowserOpenTarget;
  "curatorRemote.enabled"?: boolean;
  "curatorRemote.host"?: string;
  "curatorRemote.bind"?: string;
  "webSearch.enabled"?: boolean;
  "searchRouting.providers"?: string;
  "searchRouting.fallbackOn"?: string;
  openaiApiKey?: string;
  openaiResponsesUrl?: string;
  openaiSearchModel?: string;
  braveApiKey?: string;
  parallelApiKey?: string;
  tinyfishApiKey?: string;
  search1apiApiKey?: string;
  searchinfinityApiKey?: string;
  queritApiKey?: string;
  tavilyApiKey?: string;
  serpdiveApiKey?: string;
  serpdiveModel?: string;
  kagiApiKey?: string;
  ollamaApiKey?: string;
  serpbaseApiKey?: string;
  perplexityApiKey?: string;
  exaApiKey?: string;
  geminiApiKey?: string;
  geminiBaseUrl?: string;
  cloudflareApiKey?: string;
  anysearchApiKey?: string;
  xaiApiKey?: string;
  xaiSearchModel?: string;
  brightdataApiKey?: string;
  brightdataSerpZone?: string;
  brightdataUnlockerZone?: string;
  firecrawlApiKey?: string;
  firecrawlBaseUrl?: string;
  firecrawlApiVersion?: string;
  firecrawlFreshScrape?: boolean;
  searxngBaseUrl?: string;
  searxngHeaders?: string;
  chromeProfile?: string;
  allowBrowserCookies?: boolean;
  "githubClone.enabled"?: boolean;
  "githubClone.maxRepoSizeMB"?: number;
  "githubClone.cloneTimeoutSeconds"?: number;
  "githubClone.clonePath"?: string;
  "video.enabled"?: boolean;
  "video.preferredModel"?: string;
  "video.maxSizeMB"?: number;
  "youtube.enabled"?: boolean;
  "youtube.preferredModel"?: string;
  "pdf.maxSizeMB"?: number;
  /** 域名白/黑名单由 fetchContent.domainPolicy 控制。 */
  "fetchContent.domainPolicy.allow"?: string;
  "fetchContent.domainPolicy.deny"?: string;
  "toolNames.webSearch"?: string;
  "toolNames.sourceCheck"?: string;
  "toolNames.fetchContent"?: string;
  "toolNames.getSearchContent"?: string;
}

const SEARCH_PROVIDER_OPTIONS = [
  { value: "auto", label: "auto", description: "按可用性自动选择提供商" },
  { value: "all", label: "all", description: "并发搜索所有合适的非显式付费提供商" },
  { value: "openai", label: "OpenAI", description: "Codex 订阅或 OpenAI API key" },
  { value: "brave", label: "Brave" },
  { value: "parallel", label: "Parallel" },
  { value: "tinyfish", label: "TinyFish" },
  { value: "search1api", label: "Search1API" },
  { value: "searchinfinity", label: "Searchinfinity" },
  { value: "querit", label: "Querit" },
  { value: "tavily", label: "Tavily" },
  { value: "searxng", label: "SearXNG", description: "本地/私有搜索，需配置 searxngBaseUrl" },
  { value: "perplexity", label: "Perplexity" },
  { value: "gemini", label: "Gemini" },
  { value: "exa", label: "Exa" },
  { value: "serpdive", label: "SERPdive" },
  { value: "kagi", label: "Kagi" },
  { value: "ollama", label: "Ollama Cloud" },
  { value: "anysearch", label: "AnySearch", description: "仅显式选择" },
  { value: "xai", label: "xAI", description: "仅显式选择，可能产生费用" },
  { value: "brightdata", label: "Bright Data", description: "仅显式选择，付费 SERP" },
  { value: "serpbase", label: "SerpBase", description: "仅显式选择，付费 SERP" },
];

const WORKFLOW_OPTIONS = [
  { value: "summary-review", label: "summary-review", description: "默认：打开浏览器 curator 并附带自动汇总草稿" },
  { value: "none", label: "none", description: "跳过 curator，直接返回结果" },
  { value: "auto-summary", label: "auto-summary", description: "不打开浏览器，由模型生成汇总" },
];

function secretField(
  key: string,
  label: string,
  environmentVariable: string,
  order: number,
  description?: string,
): PluginConfigurationField {
  return {
    key,
    label,
    type: "secret",
    minLength: 1,
    placeholder: "输入 API 密钥或凭据源",
    group: "提供商密钥",
    order,
    description:
      description ?? `${label}；留空时回退到环境变量 ${environmentVariable}。支持 $ENV_VAR 或 !command 凭据源。`,
  };
}

const searchProviderField: PluginConfigurationField = {
  key: "searchProvider",
  label: "搜索提供商",
  type: "select",
  options: SEARCH_PROVIDER_OPTIONS,
  description: "web_search 的默认提供商；选择 auto 时按可用性自动选择。未设置时保持上游配置文件中的值。",
  group: "搜索",
  order: 1,
};

export const WEB_ACCESS_CONFIGURATION_SCHEMA: PluginConfigurationSchema = {
  version: 1,
  fields: [
    searchProviderField,
    {
      key: "searchModel",
      label: "搜索模型",
      type: "text",
      widget: "model-selector",
      modelFormat: "model-id",
      placeholder: "gemini-3.6-flash",
      maxLength: 100,
      description: "Gemini API 搜索模型，默认 gemini-3.6-flash。",
      group: "搜索",
      order: 2,
    },
    {
      key: "summaryModel",
      label: "汇总模型",
      type: "text",
      widget: "model-selector",
      modelFormat: "provider-model",
      placeholder: "如 gemini-2.5-flash",
      maxLength: 100,
      description: "Search Curator 汇总使用的模型；留空时沿用上游默认。",
      group: "搜索",
      order: 3,
    },
    {
      key: "workflow",
      label: "搜索工作流",
      type: "select",
      options: WORKFLOW_OPTIONS,
      description: "web_search 的默认 workflow 模式。",
      group: "搜索",
      order: 4,
    },
    {
      key: "curatorTimeoutSeconds",
      label: "Curator 超时（秒）",
      type: "number",
      minimum: 1,
      maximum: 600,
      description: "浏览器 Search Curator 等待结果的超时时间。",
      group: "搜索",
      order: 5,
    },
    {
      key: "webSearch.enabled",
      label: "启用 web_search 工具",
      type: "boolean",
      description: "是否注册 web_search 和 source_check 工具。",
      group: "搜索",
      order: 6,
    },
    {
      key: "autoOpenBrowser",
      label: "自动打开 Curator",
      type: "boolean",
      description: "搜索开始时是否自动打开浏览器；远程 Curator 默认不会自动打开。",
      group: "Curator 网络",
      order: 7,
    },
    {
      key: "browser.openTarget",
      label: "Curator 打开位置",
      type: "select",
      options: [
        {
          value: "builtin",
          label: "内置浏览器",
          description: "在当前 Desktop 会话的内置浏览器面板中打开。",
        },
        {
          value: "system",
          label: "系统默认",
          description: "使用操作系统默认浏览器打开。",
        },
      ],
      description: "选择 Search Curator 自动打开的位置。",
      group: "Curator 网络",
      order: 8,
    },
    {
      key: "curatorRemote.enabled",
      label: "允许远程访问 Curator",
      type: "boolean",
      description: "启用后 Curator 默认监听 0.0.0.0，并通过带明文 token 的 URL 访问；仅在可信网络开启。",
      group: "Curator 网络",
      order: 9,
    },
    {
      key: "curatorRemote.host",
      label: "Curator 公告主机",
      type: "text",
      maxLength: 255,
      placeholder: "用于访问链接的主机名",
      description: "只改变展示给用户的访问地址，不改变监听地址。",
      group: "Curator 网络",
      order: 10,
    },
    {
      key: "curatorRemote.bind",
      label: "Curator 监听地址",
      type: "text",
      maxLength: 255,
      placeholder: "0.0.0.0",
      description: "远程模式的监听地址；0.0.0.0 会暴露到所有网络接口。",
      group: "Curator 网络",
      order: 11,
    },
    {
      key: "searchRouting.providers",
      label: "顺序回退提供商",
      type: "textarea",
      placeholder: "每行一个 provider",
      description: "仅在未显式设置搜索提供商时生效；按行依次尝试，不等同于 all 并发搜索。",
      group: "搜索路由",
      order: 12,
    },
    {
      key: "searchRouting.fallbackOn",
      label: "允许回退的错误类型",
      type: "textarea",
      placeholder: "transient\nquota\nnetwork",
      description: "每行一个：transient、quota 或 network。",
      group: "搜索路由",
      order: 13,
    },
    secretField("openaiApiKey", "OpenAI API Key", "OPENAI_API_KEY", 20),
    {
      key: "openaiResponsesUrl",
      label: "OpenAI Responses URL",
      type: "text",
      placeholder: "https://api.openai.com/v1/responses",
      pattern: "^https?://",
      patternMessage: "必须以 http:// 或 https:// 开头",
      group: "提供商高级设置",
      order: 21,
      description: "OpenAI web search 的完整 Responses API endpoint，可指向兼容网关。",
    },
    {
      key: "openaiSearchModel",
      label: "OpenAI 搜索模型",
      type: "text",
      maxLength: 200,
      group: "提供商高级设置",
      order: 22,
      description: "固定 OpenAI web search 使用的模型 ID；留空时自动选择。",
    },
    secretField("braveApiKey", "Brave API Key", "BRAVE_API_KEY", 23),
    secretField("parallelApiKey", "Parallel API Key", "PARALLEL_API_KEY", 24),
    secretField("tinyfishApiKey", "TinyFish API Key", "TINYFISH_API_KEY", 25),
    secretField("search1apiApiKey", "Search1API Key", "SEARCH1API_KEY", 26),
    secretField("searchinfinityApiKey", "Searchinfinity API Key", "SEARCHINFINITY_API_KEY", 27),
    secretField("queritApiKey", "Querit API Key", "QUERIT_API_KEY", 28),
    secretField("tavilyApiKey", "Tavily API Key", "TAVILY_API_KEY", 29),
    secretField("serpdiveApiKey", "SERPdive API Key", "SERPDIVE_API_KEY", 30),
    {
      key: "serpdiveModel",
      label: "SERPdive 模型",
      type: "select",
      options: [
        { value: "krill", label: "krill", description: "免费层，不生成合成回答" },
        { value: "mako", label: "mako", description: "提取页面中的事实句，消耗 1 credit" },
        { value: "moby", label: "moby", description: "返回完整可读内容，消耗 1.5 credits" },
      ],
      group: "提供商高级设置",
      order: 31,
      description: "SERPdive 检索深度；留空时使用免费 krill。",
    },
    secretField("kagiApiKey", "Kagi API Key", "KAGI_API_KEY", 32),
    secretField("ollamaApiKey", "Ollama Cloud API Key", "OLLAMA_API_KEY", 33),
    secretField(
      "serpbaseApiKey",
      "SerpBase API Key",
      "SERPBASE_API_KEY",
      34,
      "SerpBase 付费 Google SERP 密钥；仅在显式选择该提供商时使用。",
    ),
    secretField("perplexityApiKey", "Perplexity API Key", "PERPLEXITY_API_KEY", 35),
    secretField("exaApiKey", "Exa API Key", "EXA_API_KEY", 36),
    secretField("geminiApiKey", "Gemini API Key", "GEMINI_API_KEY", 37),
    {
      key: "geminiBaseUrl",
      label: "Gemini Base URL",
      type: "text",
      placeholder: "https://generativelanguage.googleapis.com",
      pattern: "^https?://",
      patternMessage: "必须以 http:// 或 https:// 开头",
      group: "提供商高级设置",
      order: 38,
      description: "覆盖 Gemini API 默认接口地址。",
    },
    secretField("cloudflareApiKey", "Cloudflare AI Gateway API Key", "CLOUDFLARE_API_KEY", 39),
    secretField(
      "anysearchApiKey",
      "AnySearch API Key",
      "ANYSEARCH_API_KEY",
      40,
      "AnySearch 密钥；仅在显式选择 AnySearch 时使用。",
    ),
    secretField(
      "xaiApiKey",
      "xAI API Key",
      "XAI_API_KEY",
      41,
      "xAI/Grok 搜索密钥；仅在显式选择时使用，可能产生费用。",
    ),
    {
      key: "xaiSearchModel",
      label: "xAI 搜索模型",
      type: "text",
      maxLength: 200,
      group: "提供商高级设置",
      order: 42,
      description: "固定 xAI 搜索模型 ID；留空时使用上游默认。",
    },
    secretField(
      "brightdataApiKey",
      "Bright Data API Key",
      "BRIGHTDATA_API_KEY",
      43,
      "Bright Data 付费服务密钥；需要对应 SERP 或 Web Unlocker zone。",
    ),
    {
      key: "brightdataSerpZone",
      label: "Bright Data SERP Zone",
      type: "text",
      maxLength: 200,
      group: "提供商高级设置",
      order: 44,
      description: "必须是类型为 serp 的 zone；仅用于付费搜索。",
    },
    {
      key: "brightdataUnlockerZone",
      label: "Bright Data Unlocker Zone",
      type: "text",
      maxLength: 200,
      group: "提供商高级设置",
      order: 45,
      description: "必须是类型为 unblocker 的 zone；目标 URL 会发送给 Bright Data。",
    },
    secretField("firecrawlApiKey", "Firecrawl API Key", "FIRECRAWL_API_KEY", 46),
    {
      key: "firecrawlBaseUrl",
      label: "Firecrawl Base URL",
      type: "text",
      placeholder: "https://api.firecrawl.dev",
      pattern: "^https?://",
      patternMessage: "必须以 http:// 或 https:// 开头",
      group: "提供商高级设置",
      order: 47,
      description: "覆盖 Firecrawl 默认接口地址。",
    },
    {
      key: "firecrawlApiVersion",
      label: "Firecrawl API 版本",
      type: "select",
      options: [
        { value: "v2", label: "v2" },
        { value: "v1", label: "v1" },
      ],
      group: "提供商高级设置",
      order: 48,
      description: "新服务使用 v2；旧自托管实例可选择 v1。",
    },
    {
      key: "firecrawlFreshScrape",
      label: "允许 Firecrawl 主动抓取",
      type: "boolean",
      group: "提供商高级设置",
      order: 49,
      description: "关闭时仅请求缓存；开启后会把目标 URL 交给 Firecrawl 主动访问。",
    },
    {
      key: "searxngBaseUrl",
      label: "SearXNG Base URL",
      type: "text",
      placeholder: "http://localhost:8080",
      pattern: "^https?://",
      patternMessage: "必须以 http:// 或 https:// 开头",
      group: "提供商高级设置",
      order: 50,
      description: "本地或私有 SearXNG 实例地址；配置后本地搜索优先。",
    },
    {
      key: "searxngHeaders",
      label: "SearXNG 请求头",
      type: "textarea",
      placeholder: "Header-Name: value",
      group: "提供商高级设置",
      order: 51,
      description: "每行一个请求头；适用于反向代理或 Zero Trust 认证。值会写入 0600 配置文件。",
    },
    {
      key: "chromeProfile",
      label: "Chrome 配置文件",
      type: "path",
      placeholder: "如 ~/.config/google-chrome",
      description: "浏览器 cookie 读取使用的 Chrome 用户数据目录；仅与 allowBrowserCookies 配合使用。",
      group: "浏览器与 Gemini Web",
      order: 60,
    },
    {
      key: "allowBrowserCookies",
      label: "允许读取浏览器 Cookie",
      type: "boolean",
      description:
        "允许 Gemini Web 登录态读取本机 Chromium cookie 数据。涉及本机凭据，仅在可信环境开启；也可用环境变量 PI_ALLOW_BROWSER_COOKIES=1。",
      group: "浏览器与 Gemini Web",
      order: 61,
    },
    {
      key: "githubClone.enabled",
      label: "启用 GitHub 克隆",
      type: "boolean",
      description: "fetch_content 抓取 GitHub 仓库时是否允许 git 克隆。",
      group: "GitHub 克隆",
      order: 70,
    },
    {
      key: "githubClone.maxRepoSizeMB",
      label: "仓库大小上限（MB）",
      type: "number",
      minimum: 1,
      maximum: 100_000,
      description: "超过该大小的仓库不克隆，默认 350 MB。",
      group: "GitHub 克隆",
      order: 71,
    },
    {
      key: "githubClone.cloneTimeoutSeconds",
      label: "克隆超时（秒）",
      type: "number",
      minimum: 1,
      maximum: 3600,
      description: "git 克隆超时，默认 30 秒。",
      group: "GitHub 克隆",
      order: 72,
    },
    {
      key: "githubClone.clonePath",
      label: "克隆缓存目录",
      type: "path",
      placeholder: "/tmp/pi-github-repos",
      description: "仓库克隆缓存位置，默认 /tmp/pi-github-repos。",
      group: "GitHub 克隆",
      order: 73,
    },
    {
      key: "video.enabled",
      label: "启用本地视频分析",
      type: "boolean",
      description: "是否允许 fetch_content 分析本地视频文件（需 ffmpeg）。",
      group: "视频、YouTube 与 PDF",
      order: 80,
    },
    {
      key: "video.preferredModel",
      label: "视频分析模型",
      type: "text",
      placeholder: "如 gemini-2.5-flash",
      maxLength: 100,
      group: "视频、YouTube 与 PDF",
      order: 81,
      description: "本地视频理解的优先模型。",
    },
    {
      key: "video.maxSizeMB",
      label: "视频大小上限（MB）",
      type: "number",
      minimum: 1,
      maximum: 100_000,
      group: "视频、YouTube 与 PDF",
      order: 82,
      description: "超过该大小的视频文件不分析。",
    },
    {
      key: "youtube.enabled",
      label: "启用 YouTube 理解",
      type: "boolean",
      description: "是否允许 YouTube 视频字幕/摘要（需 yt-dlp）。",
      group: "视频、YouTube 与 PDF",
      order: 83,
    },
    {
      key: "youtube.preferredModel",
      label: "YouTube 理解模型",
      type: "text",
      maxLength: 200,
      placeholder: "如 gemini-3.6-flash",
      description: "YouTube 视频理解的优先模型；留空时使用上游默认。",
      group: "视频、YouTube 与 PDF",
      order: 84,
    },
    {
      key: "pdf.maxSizeMB",
      label: "PDF 大小上限（MB）",
      type: "number",
      minimum: 1,
      maximum: 50,
      step: 1,
      description: "PDF 提取大小上限；配置 Gemini 时优先转换为 Markdown，否则使用本地 unpdf。",
      group: "视频、YouTube 与 PDF",
      order: 85,
    },
    {
      key: "fetchContent.domainPolicy.allow",
      label: "域名白名单",
      type: "textarea",
      placeholder: "每行一个域名，如 example.com",
      description: "fetch_content 仅允许抓取这些域名（未配置时允许全部域名）。",
      group: "抓取策略",
      order: 90,
    },
    {
      key: "fetchContent.domainPolicy.deny",
      label: "域名黑名单",
      type: "textarea",
      placeholder: "每行一个域名",
      description: "fetch_content 禁止抓取的域名，优先于白名单。",
      group: "抓取策略",
      order: 91,
    },
    {
      key: "toolNames.webSearch",
      label: "web_search 工具名",
      type: "text",
      pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$",
      patternMessage: "必须以字母开头，只能包含字母、数字、下划线或连字符",
      group: "工具命名",
      order: 100,
    },
    {
      key: "toolNames.sourceCheck",
      label: "source_check 工具名",
      type: "text",
      pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$",
      patternMessage: "必须以字母开头，只能包含字母、数字、下划线或连字符",
      group: "工具命名",
      order: 101,
    },
    {
      key: "toolNames.fetchContent",
      label: "fetch_content 工具名",
      type: "text",
      pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$",
      patternMessage: "必须以字母开头，只能包含字母、数字、下划线或连字符",
      group: "工具命名",
      order: 102,
    },
    {
      key: "toolNames.getSearchContent",
      label: "get_search_content 工具名",
      type: "text",
      pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$",
      patternMessage: "必须以字母开头，只能包含字母、数字、下划线或连字符",
      group: "工具命名",
      order: 103,
    },
  ],
};

export const WEB_ACCESS_CONFIGURATION_SCHEMA_JSON = `${JSON.stringify(WEB_ACCESS_CONFIGURATION_SCHEMA, null, 2)}\n`;

export function getWebSearchConfigPath(): string {
  if (process.env.PI_CODING_AGENT_DIR) return join(process.env.PI_CODING_AGENT_DIR, "web-search.json");
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "pi", "web-search.json");
  return join(homedir(), ".pi", "web-search.json");
}

type JsonObject = Record<string, unknown>;

/** 扁平 key（含点号）写入嵌套对象。 */
function setNested(target: JsonObject, key: string, value: unknown): void {
  const segments = key.split(".");
  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    const existing = cursor[segment];
    const next = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
    cursor[segment] = next;
    cursor = next as JsonObject;
  }
  cursor[segments.at(-1)!] = value;
}

/** textarea 字段按行拆分为数组。 */
function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

const TEXTAREA_KEYS = new Set([
  "fetchContent.domainPolicy.allow",
  "fetchContent.domainPolicy.deny",
]);

const CURATOR_REMOTE_KEYS = new Set([
  "curatorRemote.enabled",
  "curatorRemote.host",
  "curatorRemote.bind",
]);

const SEARCH_ROUTING_KEYS = new Set([
  "searchRouting.providers",
  "searchRouting.fallbackOn",
]);

function parseHeaderLines(value: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    const headerValue = line.slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || !headerValue) continue;
    try {
      new Headers({ [name]: headerValue });
    } catch {
      continue;
    }
    headers[name] = headerValue;
  }
  return headers;
}

function mergeCuratorRemote(target: JsonObject, config: DesktopWebAccessConfig): void {
  const enabled = config["curatorRemote.enabled"];
  const host = config["curatorRemote.host"]?.trim();
  const bind = config["curatorRemote.bind"]?.trim();
  if (enabled === undefined && !host && !bind) return;
  if (enabled === false) {
    target.curatorRemote = false;
    return;
  }

  const existing = target.curatorRemote;
  const existingObject =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as JsonObject)
      : undefined;
  if (!host && !bind) {
    if (!existingObject) target.curatorRemote = true;
    return;
  }
  target.curatorRemote = {
    ...existingObject,
    ...(host ? { host } : {}),
    ...(bind ? { bind } : {}),
  };
}

function mergeSearchRouting(target: JsonObject, config: DesktopWebAccessConfig): void {
  const providers = splitLines(config["searchRouting.providers"] ?? "");
  const fallbackOn = splitLines(config["searchRouting.fallbackOn"] ?? "");
  if (providers.length === 0 && fallbackOn.length === 0) return;

  const existing = target.searchRouting;
  const merged: JsonObject =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as JsonObject) }
      : {};
  if (providers.length > 0) merged.providers = providers;
  if (fallbackOn.length > 0) merged.fallbackOn = fallbackOn;
  if (
    !Array.isArray(merged.providers) ||
    merged.providers.length === 0 ||
    !Array.isArray(merged.fallbackOn) ||
    merged.fallbackOn.length === 0
  ) {
    return;
  }
  target.searchRouting = merged;
}

function mergeValue(target: JsonObject, key: string, value: unknown): void {
  if (
    value === undefined ||
    CURATOR_REMOTE_KEYS.has(key) ||
    SEARCH_ROUTING_KEYS.has(key)
  ) {
    return;
  }
  if (typeof value === "string") {
    if (key === "searxngHeaders") {
      const headers = parseHeaderLines(value);
      if (Object.keys(headers).length > 0) setNested(target, key, headers);
    } else if (TEXTAREA_KEYS.has(key)) {
      const lines = splitLines(value);
      if (lines.length > 0) setNested(target, key, lines);
    } else if (value.trim().length > 0) {
      setNested(target, key, value.trim());
    }
    return;
  }
  setNested(target, key, value);
}

function readExisting(path: string): JsonObject {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JsonObject;
    return {};
  } catch {
    return {};
  }
}

export function getRunCodeToolNameAliases(): Readonly<Record<string, string>> {
  const toolNames = readExisting(getWebSearchConfigPath()).toolNames;
  if (!toolNames || typeof toolNames !== "object" || Array.isArray(toolNames)) return {};
  const aliases: Record<string, string> = {};
  for (const [key, canonicalName] of Object.entries(RUN_CODE_TOOL_NAMES)) {
    const configuredName = (toolNames as JsonObject)[key];
    if (typeof configuredName === "string" && configuredName !== canonicalName) {
      aliases[configuredName] = canonicalName;
    }
  }
  return aliases;
}

export function getBrowserOpenTarget(): BrowserOpenTarget {
  const browser = readExisting(getWebSearchConfigPath()).browser;
  if (browser && typeof browser === "object" && !Array.isArray(browser)) {
    return (browser as JsonObject).openTarget === "builtin" ? "builtin" : "system";
  }
  return "system";
}

function atomicWrite(path: string, value: JsonObject): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const source = `${JSON.stringify(value, null, 2)}\n`;
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, source, { mode: 0o600 });
  try {
    renameSync(temp, path);
  } catch {
    rmSync(temp, { force: true });
    writeFileSync(path, source, { mode: 0o600 });
  }
}

/**
 * 将桌面配置表单的值合并写入上游的 ~/.pi/web-search.json。
 * 只覆盖用户显式设置的字段（getConfig 返回的既有值），保留文件中未涉及的其他配置。
 */
export function applyDesktopConfig(config: DesktopWebAccessConfig | undefined): void {
  if (!config || typeof config !== "object") return;
  const path = getWebSearchConfigPath();
  const target = readExisting(path);
  const previous = JSON.stringify(target);
  mergeCuratorRemote(target, config);
  mergeSearchRouting(target, config);
  for (const [key, value] of Object.entries(config)) {
    mergeValue(target, key, value);
  }
  if (JSON.stringify(target) === previous) return;
  atomicWrite(path, target);
}
