---
name: image-cutout
description: 通过视觉判断选择图片主体，并使用确定性图像处理生成原尺寸 RGBA PNG。适用于已有透明通道、纯色或平滑渐变背景，以及通过矩形、前景点、背景点或提示掩码引导的复杂背景；不下载或运行额外模型。
compatibility: 需要调用智能体能够查看图片，或由用户提供主体范围；需要 Python 3.10 或更高版本以及 requirements.txt 中的依赖。
---

# Image Cutout

先理解图片，再调用脚本。调用本技能的智能体负责判断什么是主体、哪些分离部件属于主体以及哪些内容应排除；CLI 只把这些语义判断转换为像素级 Alpha。

不得让 CLI 在没有语义指导时猜测复杂图片的主体。

## Setup

首次使用时，在技能目录创建隔离环境并安装锁定依赖：

```bash
python -m venv .venv
.venv/Scripts/python -m pip install --requirement requirements.txt
```

Linux 或 macOS 使用 `.venv/bin/python`。路径相对于本 `SKILL.md` 所在目录解析。

## Workflow

### 1. 查看原图并确定主体

使用可用的图片查看工具读取原图，不要先运行自动抠图来代替视觉判断。

根据用户要求和画面语义，用一句简短描述记录主体。用户只说“抠图”时，选择视觉上明确的主要对象，并包括与它语义相连的部件，例如人物携带的武器、商品附件或角色周围分离的特效。不要因为部件不连通就删除它。

以下情况先询问用户：

- 多个对象具有相同的视觉主次，无法确定要保留哪一个。
- 水印、文字、阴影、倒影或特效是否属于主体存在实质歧义。
- 用户要求与图片内容不一致。

### 2. 选择确定性路线

按视觉事实选择路线，不要让像素统计决定语义主体：

- 输入已有有效透明通道：使用 `auto` 或 `alpha`，保留原 Alpha。
- 背景是单一颜色或平滑渐变，主体与背景有清楚色差：显式使用 `background`。
- 背景复杂、主体触边、前景与背景近色或只保留局部对象：使用 `grabcut` 并提供空间提示。

无有效 Alpha 且没有提示时，`auto` 会返回 `guidance-required`。这是防止脚本静默选择错误主体的必要约束。

### 3. 把语义判断转换为提示

每次生成新 Alpha 时传入 `--subject`。GrabCut 至少需要下列一种前景提示：

- 一个或多个 `--rect x,y,width,height`：分别框住需要保留的对象或分离部件；矩形可重复。
- 一个或多个 `--foreground-point x,y`：放在确定属于主体的内部区域；参数可重复。
- `--foreground-mask path`：白色表示确定前景，黑色表示未指定。

用 `--background-point x,y` 或 `--background-mask path` 标记容易被误保留的背景。点应落在区域内部，不要放在边缘；坐标存在误差时用 `--point-radius` 调整提示半径。

`background` 路线视觉复查后仍有背景色边时，可提高 `--background-tolerance`；主体边缘被削弱时降低该值。它是颜色距离上限，不是准确率。省略时由边界噪声自动计算，调整时应小步迭代并重新查看全部预览。

当主体在语义上完全不透明（例如商品、人物、图标或精灵），可加 `--opaque-subject`。该精修把主体内部恢复为原始不透明 RGB，只在外轮廓保留约一个像素的抗锯齿，并从最近的内部像素延展轮廓色。它还会填补面积不超过图像 `0.01%` 的封闭针孔，但保留与外部连通或更大的真实开口。半透明玻璃、烟雾、薄纱、毛发细节等不得使用此选项。

提示掩码必须与经过 EXIF 方向归一化后的输入尺寸一致。确定前景点/掩码与确定背景点/掩码不能重叠。矩形只表示候选前景范围，内部可以放置背景点或背景掩码来排除误框区域。

### 4. 运行并生成复查材料

已有 Alpha：

```bash
python scripts/cutout.py --input input.png --output output.png --mode auto --json
```

明确的简单背景：

```bash
python scripts/cutout.py --input input.png --output output.png --mode background --subject "前景商品及其附件" --artifacts-dir artifacts --json
```

复杂背景或多个分离主体部件：

```bash
python scripts/cutout.py --input input.jpg --output output.png --mode grabcut --subject "士兵、武器和背包" --rect 40,20,500,900 --rect 520,300,180,220 --foreground-point 260,420 --background-point 20,20 --background-point 740,40 --artifacts-dir artifacts --json
```

精细提示：

```bash
python scripts/cutout.py --input input.jpg --output output.png --mode grabcut --subject "人物和头发" --rect 40,20,720,900 --foreground-mask foreground.png --background-mask background.png --artifacts-dir artifacts --json
```

### 5. 查看结果并迭代

读取 JSON 的 `status`、`warnings`、`metrics` 和 `artifacts`，不能只检查退出码。所有新生成的 Alpha 都必须查看：

- `previewLight`：发现深色残边和误删的浅色细节。
- `previewDark`：发现浅色光晕和背景污染。
- `previewChecker`：检查透明区域、孔洞和不连续部件。
- `alpha` 与 `mask`：确认保留对象与步骤 1 的主体描述一致。

根据可见问题调整提示后重新运行：

- 背景被保留：GrabCut 路线增加背景点或背景掩码；`background` 路线小幅提高 `--background-tolerance`。
- 主体局部被删除：GrabCut 路线增加前景点或独立矩形；`background` 路线降低 `--background-tolerance`。
- 保留了错误对象：缩紧矩形，并给错误对象增加背景点。
- 孔洞被填满：在孔洞内部增加背景点。
- 分离部件消失：给每个部件单独增加矩形或前景点。
- 简单背景出现色边：改用 `background` 路线并复查去污染结果。

只有预览与记录的主体描述一致、尺寸正确且没有明显残边时才交付。`review` 表示需要完成上述视觉复查，不表示命令失败。

## CLI Contract

- `--background-tolerance`：只用于显式 `background` 路线；提高会把更宽的相近颜色区域视为连通背景，必须通过预览防止误删主体。
- `--opaque-subject`：只用于显式 `background` 路线；适合完全不透明主体，禁止用于需要保留内部半透明度的材质。
- `--foreground-threshold`：只用于 `--opaque-subject`，默认 `128`；提高会收紧用于精修的主体区域，需检查细部是否被削弱。
- `--edge-inset`：只用于 `--opaque-subject`，默认 `0`；向内收缩确认的前景轮廓，适合去除混色边，值越大越容易削弱细部。
- `--min-component-area`：只用于 `--opaque-subject`，默认 `0`；删除小于该面积的非连通前景组件。只有视觉确认小组件是噪声时才设置，例如本组图像使用 `32`；默认不删除，以保留多部件主体。
- `--subject`：生成新 Alpha 时必填，且不能是空白字符串；保留已有 Alpha 时可以省略。
- `--artifacts-dir`：生成新 Alpha 时必填，确保智能体能够执行视觉复查；保留已有 Alpha 时可选。
- `--rect`、`--foreground-point` 和 `--background-point` 均可重复。
- `--point-radius` 必须为正整数，默认 `3` 像素。
- `route` 为 `existing-alpha`、`solid-background`、`gradient-background` 或 `guided-grabcut`。
- 成功执行的 `status` 为 `pass` 或 `review`；处理失败为 `error`。
- 退出码 `0` 表示已生成结果，包括 `review`；退出码 `2` 表示输入、提示、资源限制或处理错误。
- 标准输出在 `--json` 下是单个 JSON 对象，日志和错误不得混入。

完整字段见 [references/output-contract.md](references/output-contract.md)。

## Output Invariants

- 输出始终是与方向归一化后输入同尺寸的 straight-alpha RGBA PNG。
- 不透明主体像素的 RGB 保持不变。
- 简单背景路线可修正半透明过渡像素的背景污染，并报告 `rgbModifiedPixelCount`。
- `sourceRgbPreserved` 只有在所有 RGB 都未修改时为 `true`。
- 指标只描述输出结构，不能称为准确率、概率或语义置信度。

## Safety

- 默认最多读取 50 MiB、8,000,000 像素的图片；提示掩码受相同文件大小限制。
- 不要关闭 Pillow 的 decompression-bomb 检查。
- 不要在运行时安装依赖、下载模型或访问外部推理服务。
- 不覆盖输入或提示文件；输出和 artifact 与受保护文件路径相同、符号链接相同或硬链接相同时都会拒绝。
- 所有 PNG 使用同目录临时文件后原子替换。
