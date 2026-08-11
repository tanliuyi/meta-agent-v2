---
name: editorial-screenprint-plugin-icons
description: 为 Meta Agent 插件生成统一的彩色、个性化、简约编辑刊物丝网印刷风格图标，并完成 PNG 资源、manifest 与 payload 验证。
---

# Editorial Screenprint Plugin Icons

## When to Use

当需要为 `packages/plugins/*` 生成或替换统一风格的插件图标时使用。适用于 image_gen 生成、PNG 优化、manifest 同步和 payload 验证；不用于一般插画、营销海报或非插件图片。

## Procedure

1. 读取目标插件的 `market-manifest.json`、用途描述和现有 `assets/icon.*`，为每个插件确定一个独立的语义主图形，不直接复用其他插件的主体。
2. 使用 `functions.image_generate` 在临时目录生成 PNG。默认参数使用 `quality: "auto"`、`size: "1024x1024"`、`n: 1`，先生成一枚风格样稿，再生成其余图标。
3. 所有图标使用统一视觉方向：高端编辑刊物与丝网印刷海报风格、非对称几何构图、深靛色墨线轮廓、两到五种高饱和扁平色块、轻微纸张印刷质感、透明或干净背景、无文字、无 3D、无渐变，并确保在 24px 仍清晰。
4. 根据插件语义选择主体：Image Generation 使用图片框与生成星；Office 使用折页文档、网格或结构化数据；Web Access 使用地球、开放网络路径和方向箭头；Figma 使用互锁几何画布块和光标；Billion Context 使用多层信息板、连接线和节点。
5. 使用 `functions.read` 逐张进行视觉检查。主体太小、细节过密、像普通彩色贴纸或与同套风格不一致时，调整 prompt 后重新生成。
6. 在 macOS 上用 `/usr/bin/sips -Z 256` 生成 256×256 优化 PNG，保存到临时 optimized 目录；检查像素尺寸和文件大小，单个图标必须小于 1 MiB。
7. 将最终 PNG 复制到 `packages/plugins/<plugin>/assets/icon.png`，把 manifest 的 `files` 声明同步为 `assets/icon.png`，删除旧的 `assets/icon.svg`。不要把图片转成 SVG 或以内嵌 data URI 包装。
8. 使用现有 plugin-publish payload builder 构建并检查 payload，确认 archive 包含 `payload/assets/icon.png`、manifest 文件列表一致且没有旧 SVG；需要发布时再遵循 plugin-publish skill 的发布流程。

## Pitfalls

- 不要生成通用贴纸、Emoji、素材库图标、3D、玻璃质感或渐变效果。
- 不要加入文字、字母、数字、UI 截图或投影；图形必须在 18px 到 40px 尺寸仍然可辨认。
- Web Access 是平台无关的网络能力，禁止浏览器窗口、桌面 UI、标签页、显示器、笔记本和设备边框。
- Figma 图标表达设计画布和协作关系即可，不要直接复刻官方 Figma 标志。
- 临时生成目录只保存预览和优化中间产物，payload 必须通过 manifest 和打包脚本重新确认。
- 生成密钥、API key 和登录 token 不得写入 prompt、脚本、仓库或发布包。

## Verification

- 所有目标插件都有真实 `assets/icon.png`，尺寸为 256×256，且每个文件小于 1 MiB。
- 每个 `market-manifest.json` 的文件列表声明 `assets/icon.png`，旧 `assets/icon.svg` 不存在。
- payload 构建成功，archive 中包含 `payload/assets/icon.png`，entry 和 manifest 校验通过，未残留旧图标格式。
- 在 Composer 的 18px 尺寸和插件市场约 40px 的尺寸下，图标主体清楚、颜色有区分且没有文字或复杂噪点。
- 运行目标包的 typecheck、图标相关测试和 `git diff --check`；全仓检查若被既有 shrinkwrap 问题阻断，记录精确错误而不擅自修改无关 shrinkwrap。
