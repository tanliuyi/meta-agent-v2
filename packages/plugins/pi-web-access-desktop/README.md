# Pi Web Access Desktop

这是 [`pi-web-access`](https://github.com/nicobailon/pi-web-access) 的 Meta Agent Desktop Host Profile v1 适配入口。

## Marketplace 描述

发布到插件市场时使用的描述（marketplace ID `meta-agent-development`，publisher `admin`，插件 `pi.web-access`）：

> 为桌面端提供联网能力：网页搜索（OpenAI、Brave、Parallel、Tavily、SERPdive、SearXNG、AnySearch、Exa、Perplexity、Gemini）、网页内容抓取、GitHub 仓库克隆、PDF 文本提取、YouTube 与本地视频理解。内置 /websearch、/search、/curator、/google-account 命令与浏览器端 Search Curator。

## 桌面配置

插件声明了 Marketplace 配置 schema（`WEB_ACCESS_CONFIGURATION_SCHEMA`，34 个字段）。从市场安装后，Desktop 会在 **Plugin detail > 配置** 渲染表单，并把用户保存的值通过 `pi.getConfig()` 交给插件；插件启动时将**显式设置的字段**合并写入上游配置文件 `~/.pi/web-search.json`（0600 权限，不覆盖文件中未涉及的已有配置，如 `toolNames`、`shortcuts`、keychain 凭据）。

字段分组：

| 组 | 字段 | 说明 |
| --- | --- | --- |
| 搜索 | `searchProvider`、`searchModel`、`summaryModel`、`workflow`、`curatorTimeoutSeconds`、`webSearch.enabled` | 默认提供商、搜索/汇总模型、工作流模式 |
| 提供商密钥 | 各提供商 `*ApiKey`、`firecrawlBaseUrl`、`searxngBaseUrl`、`geminiBaseUrl`、`serpdiveModel` | 密钥留空时回退到同名环境变量 |
| 浏览器与 Gemini Web | `chromeProfile`、`allowBrowserCookies` | 浏览器 cookie 登录态（涉及本机凭据，谨慎开启） |
| GitHub 克隆 | `githubClone.*` | 仓库大小/超时/缓存目录 |
| 视频与 YouTube | `video.*`、`youtube.enabled` | 本地视频与 YouTube 理解 |
| 抓取安全 | `ssrf.allowRanges`、`ssrf.trustEnvProxy`、`fetchContent.domainPolicy.*` | SSRF 网段与域名白/黑名单（textarea 按行拆分） |

嵌套字段（如 `githubClone.enabled`、`ssrf.allowRanges`）以点号 key 在表单中展开，写入时映射为 `web-search.json` 的嵌套结构。空字符串与未设置的值不会写入，避免覆盖用户已有的文件配置。

Developer Mode 本地加载时不提供市场配置表单；直接编辑 `~/.pi/web-search.json` 或使用环境变量。

## 功能

保留上游扩展的核心功能：

- `web_search`
- `source_check`
- `fetch_content`
- `get_search_content`
- `/websearch`、`/curator`、`/google-account` 和 `/search`
- 浏览器中的 Search Curator
- 会话结果存储与 shutdown 清理

Desktop 不提供 Pi TUI 快捷键和自定义 TUI 工具渲染，因此此入口会忽略上游的 `registerShortcut()` 调用，并移除工具的 `renderCall`/`renderResult` 回调。工具结果仍通过标准文本、图片和结构化 `details` 显示。

## 安装依赖

在本目录运行：

```bash
npm install --ignore-scripts --omit=peer
```

没有 install/postinstall 脚本。依赖固定使用 `pi-web-access@0.14.0`，其余 Pi host 包由 Desktop 提供；`--omit=peer` 可避免在插件目录重复安装 host 包。

## 在 Desktop 中加载

1. 打开 `设置 > Extensions > 本地插件`。
2. 开启 `Developer Mode`。
3. 选择 `添加本地插件`。
4. 选择本目录中的 `index.ts`。
5. 对新会话直接生效；已有会话在 Composer 中运行 `/reload`。

配置沿用上游路径 `~/.pi/web-search.json`。默认无需 API key，可使用 Exa MCP；其他 provider、浏览器 cookie、GitHub clone、视频和 SSRF 配置请参考上游文档。

## 权限与风险

该插件以当前账户权限运行，不是 sandbox。它可以访问网络、文件、环境变量和子进程；GitHub 抓取可能执行 `git`/`gh`，视频功能可能执行 `ffmpeg`/`yt-dlp`，浏览器 curator 会启动本地 HTTP 服务并尝试打开浏览器。启用 `allowBrowserCookies` 后还会读取本机 Chromium cookie 数据。凭据应放在环境变量或 `~/.pi/web-search.json`，不要写入源码或日志。

## 验证

```bash
npm run typecheck
npm test
```

测试使用假的 Extension API，不会调用搜索 provider 或产生付费请求。
