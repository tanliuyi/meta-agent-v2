# Pi OfficeCLI

基于 [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI)（Apache-2.0）的 Meta Agent Desktop 插件，为会话提供 `.docx` / `.xlsx` / `.pptx` 文档的创建、读取与编辑能力。

## Marketplace 描述

发布到插件市场时使用的描述（marketplace ID `meta-agent-development`，publisher `admin`，插件 `pi.officecli`）：

> 在会话中创建、读取、编辑 Word、Excel、PowerPoint 文档（.docx/.xlsx/.pptx）。底层由 OfficeCLI 提供：DOM 路径寻址、CSS 风格查询、原子批量编辑、OpenXML 校验、模板合并，以及内置 HTML/PNG 渲染引擎用于检查排版效果。二进制首次使用时自动下载（固定版本 tag + SHA256 校验），无需安装 Microsoft Office。

## Behavior

- 注册 11 个工具：`office_view`、`office_get`、`office_query`、`office_dump`、`office_create`、`office_edit`、`office_batch`、`office_merge`、`office_validate`、`office_render`、`office_help`。
- 二进制获取：优先 `binaryPath` 配置；否则在 `~/.pi/agent/officecli/` 查找已下载的二进制；都没有时自动下载（d.officecli.ai 镜像 → GitHub Releases 回退，SHA256SUMS 可达时校验，`--version` 验证）。下载版本可通过 `version` 配置固定。
- 只支持 OfficeCLI 主格式（.docx/.xlsx/.pptx）。PDF 读取/编辑不支持；PDF 导出需要 OfficeCLI 官方 exporter 插件，本插件不内置。
- 所有修改类工具（create/edit/batch/merge）通过 pi 的文件变更队列串行化，与内置工具并发编辑同一文件时安全。
- 所有写操作默认原子：`office_batch` 任一条失败整批回滚（除非 `bestEffort`）。
- 输出截断到 50 KB / 2000 行，并给出缩小范围的提示。
- 文档路径相对会话工作目录解析，也接受绝对路径。

## Configuration

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `binaryPath` | path | 空 | 已安装 officecli 的绝对路径；配置后不再下载。 |
| `version` | text | `v1.0.143` | 自动下载使用的 Release tag。 |
| `autoDownload` | boolean | `true` | 二进制缺失时是否自动下载。 |

## Install

本地开发：Desktop Settings > Extensions > Developer Mode > Add local extension，选择本目录（入口 `index.ts`）。

## Security

- OfficeCLI 二进制从官方镜像/GitHub Releases 下载，下载时尝试校验 SHA256SUMS（校验文件不可达时跳过校验）；仍建议确认二进制来源后再使用。
- 工具以当前用户权限运行，文档编辑会真实改写文件；批量操作默认原子回滚，但 `office_edit` 的逐条修改不可撤销。
- 插件不暴露 OfficeCLI 的 `raw`/`raw-set`（原始 XML 注入）命令。
- `office_batch` 接受自由 JSON 操作列表，属于文档编辑的正常能力范围。
