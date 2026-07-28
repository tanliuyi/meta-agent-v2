# Pi Web Access Desktop

这是 [`pi-web-access`](https://github.com/nicobailon/pi-web-access) 的 Meta Agent Desktop Host Profile v1 适配入口。

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
