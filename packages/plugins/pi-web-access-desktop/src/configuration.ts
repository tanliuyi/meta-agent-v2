import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
  "webSearch.enabled"?: boolean;
  openaiApiKey?: string;
  braveApiKey?: string;
  parallelApiKey?: string;
  tavilyApiKey?: string;
  serpdiveApiKey?: string;
  serpdiveModel?: string;
  perplexityApiKey?: string;
  exaApiKey?: string;
  geminiApiKey?: string;
  anysearchApiKey?: string;
  firecrawlApiKey?: string;
  firecrawlBaseUrl?: string;
  searxngBaseUrl?: string;
  geminiBaseUrl?: string;
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
  "ssrf.allowRanges"?: string;
  "ssrf.trustEnvProxy"?: boolean;
  "fetchContent.domainPolicy.allow"?: string;
  "fetchContent.domainPolicy.deny"?: string;
}

const SEARCH_PROVIDER_OPTIONS = [
  { value: "auto", label: "auto", description: "自动选择：优先 OpenAI，其次 Exa、Brave、Parallel 等可用提供商" },
  { value: "openai", label: "OpenAI", description: "Codex 订阅或 OpenAI API key" },
  { value: "brave", label: "Brave" },
  { value: "parallel", label: "Parallel" },
  { value: "tavily", label: "Tavily" },
  { value: "searxng", label: "SearXNG", description: "本地/私有搜索，需配置 searxngBaseUrl" },
  { value: "perplexity", label: "Perplexity" },
  { value: "gemini", label: "Gemini" },
  { value: "exa", label: "Exa" },
  { value: "serpdive", label: "SERPdive" },
  { value: "anysearch", label: "AnySearch" },
];

const WORKFLOW_OPTIONS = [
  { value: "summary-review", label: "summary-review", description: "默认：打开浏览器 curator 并附带自动汇总草稿" },
  { value: "none", label: "none", description: "跳过 curator，直接返回结果" },
  { value: "auto-summary", label: "auto-summary", description: "不打开浏览器，由模型生成汇总" },
];

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
      placeholder: "gemini-2.5-flash",
      maxLength: 100,
      description: "搜索与汇总使用的模型 ID，默认 gemini-2.5-flash。",
      group: "搜索",
      order: 2,
    },
    {
      key: "summaryModel",
      label: "汇总模型",
      type: "text",
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
      maximum: 3600,
      description: "浏览器 Search Curator 等待结果的超时时间。",
      group: "搜索",
      order: 5,
    },
    {
      key: "webSearch.enabled",
      label: "启用 web_search 工具",
      type: "boolean",
      description: "是否注册 web_search 工具。",
      group: "搜索",
      order: 6,
    },
    {
      key: "openaiApiKey",
      label: "OpenAI API Key",
      type: "secret",
      minLength: 8,
      placeholder: "输入 API 密钥",
      group: "提供商密钥",
      order: 10,
      description: "OpenAI 搜索密钥；留空时回退到环境变量 OPENAI_API_KEY。保存后由系统凭据加密存储。",
    },
    {
      key: "braveApiKey",
      label: "Brave API Key",
      type: "secret",
      minLength: 8,
      placeholder: "输入 API 密钥",
      group: "提供商密钥",
      order: 11,
      description: "Brave Search API 密钥；留空时回退到环境变量 BRAVE_API_KEY。",
    },
    {
      key: "parallelApiKey",
      label: "Parallel API Key",
      type: "secret",
      minLength: 8,
      placeholder: "输入 API 密钥",
      group: "提供商密钥",
      order: 12,
      description: "Parallel 搜索密钥；留空时回退到环境变量 PARALLEL_API_KEY。",
    },
    {
      key: "tavilyApiKey",
      label: "Tavily API Key",
      type: "secret",
      minLength: 8,
      placeholder: "输入 API 密钥",
      group: "提供商密钥",
      order: 13,
      description: "Tavily 搜索密钥；留空时回退到环境变量 TAVILY_API_KEY。",
    },
    {
      key: "serpdiveApiKey",
      label: "SERPdive API Key",
      type: "secret",
      minLength: 8,
      placeholder: "输入 API 密钥",
      group: "提供商密钥",
      order: 14,
      description: "SERPdive 搜索密钥；留空时回退到环境变量 SERPDIVE_API_KEY。",
    },
    {
      key: "serpdiveModel",
      label: "SERPdive 模型",
      type: "text",
      placeholder: "如 gpt-4o-mini",
      maxLength: 100,
      group: "提供商密钥",
      order: 15,
      description: "SERPdive 合成回答使用的模型。",
    },
    {
      key: "perplexityApiKey",
      label: "Perplexity API Key",
      type: "secret",
      minLength: 8,
      placeholder: "输入 API 密钥",
      group: "提供商密钥",
      order: 16,
      description: "Perplexity 搜索密钥；留空时回退到环境变量 PERPLEXITY_API_KEY。",
    },
    {
      key: "exaApiKey",
      label: "Exa API Key",
      type: "secret",
      minLength: 8,
      placeholder: "输入 API 密钥",
      group: "提供商密钥",
      order: 17,
      description: "Exa 搜索密钥；留空时回退到环境变量 EXA_API_KEY。",
    },
    {
      key: "geminiApiKey",
      label: "Gemini API Key",
      type: "secret",
      minLength: 8,
      placeholder: "输入 API 密钥",
      group: "提供商密钥",
      order: 18,
      description: "Gemini API 密钥；留空时回退到环境变量 GEMINI_API_KEY。",
    },
    {
      key: "anysearchApiKey",
      label: "AnySearch API Key",
      type: "secret",
      minLength: 8,
      placeholder: "输入 API 密钥",
      group: "提供商密钥",
      order: 19,
      description: "AnySearch 密钥（仅在显式选择 AnySearch 时使用）；留空时回退到环境变量。",
    },
    {
      key: "firecrawlApiKey",
      label: "Firecrawl API Key",
      type: "secret",
      minLength: 8,
      placeholder: "输入 API 密钥",
      group: "提供商密钥",
      order: 20,
      description: "Firecrawl 抓取服务密钥；留空时回退到环境变量 FIRECRAWL_API_KEY。",
    },
    {
      key: "firecrawlBaseUrl",
      label: "Firecrawl Base URL",
      type: "text",
      placeholder: "https://api.firecrawl.dev",
      pattern: "^https?://",
      patternMessage: "必须以 http:// 或 https:// 开头",
      group: "提供商密钥",
      order: 21,
      description: "覆盖 Firecrawl 默认接口地址。",
    },
    {
      key: "searxngBaseUrl",
      label: "SearXNG Base URL",
      type: "text",
      placeholder: "http://localhost:8080",
      pattern: "^https?://",
      patternMessage: "必须以 http:// 或 https:// 开头",
      group: "提供商密钥",
      order: 22,
      description: "本地或私有 SearXNG 实例地址；配置后本地搜索优先。",
    },
    {
      key: "geminiBaseUrl",
      label: "Gemini Base URL",
      type: "text",
      placeholder: "https://generativelanguage.googleapis.com",
      pattern: "^https?://",
      patternMessage: "必须以 http:// 或 https:// 开头",
      group: "提供商密钥",
      order: 23,
      description: "覆盖 Gemini API 默认接口地址。",
    },
    {
      key: "chromeProfile",
      label: "Chrome 配置文件",
      type: "path",
      placeholder: "如 ~/.config/google-chrome",
      description: "浏览器 cookie 读取使用的 Chrome 用户数据目录；仅与 allowBrowserCookies 配合使用。",
      group: "浏览器与 Gemini Web",
      order: 30,
    },
    {
      key: "allowBrowserCookies",
      label: "允许读取浏览器 Cookie",
      type: "boolean",
      description:
        "允许 Gemini Web 登录态读取本机 Chromium cookie 数据。涉及本机凭据，仅在可信环境开启；也可用环境变量 PI_ALLOW_BROWSER_COOKIES=1。",
      group: "浏览器与 Gemini Web",
      order: 31,
    },
    {
      key: "githubClone.enabled",
      label: "启用 GitHub 克隆",
      type: "boolean",
      description: "fetch_content 抓取 GitHub 仓库时是否允许 git 克隆。",
      group: "GitHub 克隆",
      order: 40,
    },
    {
      key: "githubClone.maxRepoSizeMB",
      label: "仓库大小上限（MB）",
      type: "number",
      minimum: 1,
      maximum: 100_000,
      description: "超过该大小的仓库不克隆，默认 350 MB。",
      group: "GitHub 克隆",
      order: 41,
    },
    {
      key: "githubClone.cloneTimeoutSeconds",
      label: "克隆超时（秒）",
      type: "number",
      minimum: 1,
      maximum: 3600,
      description: "git 克隆超时，默认 30 秒。",
      group: "GitHub 克隆",
      order: 42,
    },
    {
      key: "githubClone.clonePath",
      label: "克隆缓存目录",
      type: "path",
      placeholder: "/tmp/pi-github-repos",
      description: "仓库克隆缓存位置，默认 /tmp/pi-github-repos。",
      group: "GitHub 克隆",
      order: 43,
    },
    {
      key: "video.enabled",
      label: "启用本地视频分析",
      type: "boolean",
      description: "是否允许 fetch_content 分析本地视频文件（需 ffmpeg）。",
      group: "视频与 YouTube",
      order: 50,
    },
    {
      key: "video.preferredModel",
      label: "视频分析模型",
      type: "text",
      placeholder: "如 gemini-2.5-flash",
      maxLength: 100,
      group: "视频与 YouTube",
      order: 51,
      description: "本地视频理解的优先模型。",
    },
    {
      key: "video.maxSizeMB",
      label: "视频大小上限（MB）",
      type: "number",
      minimum: 1,
      maximum: 100_000,
      group: "视频与 YouTube",
      order: 52,
      description: "超过该大小的视频文件不分析。",
    },
    {
      key: "youtube.enabled",
      label: "启用 YouTube 理解",
      type: "boolean",
      description: "是否允许 YouTube 视频字幕/摘要（需 yt-dlp）。",
      group: "视频与 YouTube",
      order: 53,
    },
    {
      key: "ssrf.allowRanges",
      label: "SSRF 允许网段",
      type: "textarea",
      placeholder: "如 10.0.0.0/8，每行一个 CIDR",
      description: "fetch_content 允许访问的内网网段（CIDR，每行一个）。默认禁止私有网段。",
      group: "抓取安全",
      order: 60,
    },
    {
      key: "ssrf.trustEnvProxy",
      label: "信任环境代理",
      type: "boolean",
      description: "是否信任 HTTP(S)_PROXY 等环境代理变量（可能绕过 SSRF 限制）。",
      group: "抓取安全",
      order: 61,
    },
    {
      key: "fetchContent.domainPolicy.allow",
      label: "域名白名单",
      type: "textarea",
      placeholder: "每行一个域名，如 example.com",
      description: "fetch_content 仅允许抓取这些域名（未配置时允许全部非私有地址）。",
      group: "抓取安全",
      order: 62,
    },
    {
      key: "fetchContent.domainPolicy.deny",
      label: "域名黑名单",
      type: "textarea",
      placeholder: "每行一个域名",
      description: "fetch_content 禁止抓取的域名，优先于白名单。",
      group: "抓取安全",
      order: 63,
    },
  ],
};

export const WEB_ACCESS_CONFIGURATION_SCHEMA_JSON = `${JSON.stringify(WEB_ACCESS_CONFIGURATION_SCHEMA, null, 2)}\n`;

export function getWebSearchConfigPath(): string {
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
  "ssrf.allowRanges",
  "fetchContent.domainPolicy.allow",
  "fetchContent.domainPolicy.deny",
]);

function mergeValue(target: JsonObject, key: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value === "string") {
    if (TEXTAREA_KEYS.has(key)) {
      setNested(target, key, splitLines(value));
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
  for (const [key, value] of Object.entries(config)) {
    mergeValue(target, key, value);
  }
  atomicWrite(path, target);
}
