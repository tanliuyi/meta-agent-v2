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
- `--foreground-mask path`：白色表示确定前景，黑色表示未指定；适合不规则局部轮廓。
- `--foreground-region x,y,width,height`：确定前景的局部矩形硬约束，参数可重复；适合 agent 在复查中确认必须保留的细线、箭羽或小部件。
- `--foreground-polygon x1,y1;x2,y2;...`：确定前景的不规则多边形硬约束，参数可重复；适合精确圈定局部细部。

用 `--background-point x,y`、`--background-region x,y,width,height`、`--background-polygon x1,y1;x2,y2;...` 或 `--background-mask path` 标记容易被误保留的背景。点应落在区域内部，不要放在边缘；坐标存在误差时用 `--point-radius` 调整提示半径。局部 region/polygon 是确定硬约束，只能覆盖 agent 已确认的纯背景孔洞；只要范围内混有前景轮廓、细线或附件，就不能使用 region/polygon，应改用内部背景点或只标记已确认背景像素的 mask。不要用大矩形代替语义判断。

用户提供的标注截图可能经过缩放、裁剪或 `object-fit` 定位，截图坐标不得直接作为原图提示坐标。必须重新读取方向归一化后的原图，在原始像素坐标中定位提示；无法可靠换算时，使用原图局部放大图重新判断。颜色筛选只能在 agent 已从视觉上确认的局部背景区域内生成提示 mask，不能让全图颜色统计代替语义判断。

`background` 路线视觉复查后仍有背景色边时，可提高 `--background-tolerance`；主体边缘被削弱时降低该值。它是颜色距离上限，不是准确率。省略时由边界噪声自动计算，调整时应小步迭代并重新查看全部预览。

当主体在语义上完全不透明（例如商品、人物、图标或精灵），可加 `--opaque-subject`。该精修把主体内部恢复为原始不透明 RGB，只在外轮廓保留约一个像素的抗锯齿，并从最近的内部像素延展轮廓色。它还会填补面积不超过图像 `0.01%` 的封闭针孔，但保留与外部连通或更大的真实开口。半透明玻璃、烟雾、薄纱、毛发细节等不得使用此选项。

“主体材质不透明”不等于“主体轮廓内部没有透明背景”。线稿角色、武器、发饰、箭羽、弓弦等部件之间经常存在应透明的封闭背景岛；只要这些孔洞可能小于图像 `0.01%`，首轮候选就不得启用 `--opaque-subject`。必须先在 alpha/mask 和局部放大预览中确认所有应透明孔洞均保留，再决定是否启用；启用后的候选必须与未启用版本逐孔对比。

提示掩码必须与经过 EXIF 方向归一化后的输入尺寸一致。确定前景点/掩码与确定背景点/掩码不能重叠。矩形只表示候选前景范围，内部可以放置背景点或背景掩码来排除误框区域。

### 4. Agent 自主生成与复查

默认由 agent 完成完整闭环，不把参数选择和预览判断交给用户。除非主体语义确实有歧义，agent 不应先询问用户“保留哪些区域”或“使用什么参数”。

1. 先用视觉能力读取原图，记录主体、分离部件、应透明的孔洞和可能的背景纹理。若用户提供标注截图，必须回到原图逐个重新定位，不得直接复用截图框坐标。
2. 根据视觉事实选择路线；对纯色、渐变或纹理但颜色可区分的背景，先使用 `background`，并自行尝试一组小范围容差候选（例如自动边界值附近的 `+8`、`+16`、`+32`）。`background` 只会移除与图像边界连通的背景候选；被黑色轮廓或部件完全包围的背景岛可能保留，此时改用 `grabcut`，为每个孔洞提供内部背景点或精确背景 mask。
3. 首轮候选默认不启用 `--opaque-subject`。只有确认主体内部不存在应透明的小孔洞，或未启用版本的所有孔洞已正确透明后，才生成启用版本进行对比。初始精修使用 `--foreground-threshold 144 --edge-inset 1`；只有视觉确认孤立小点是噪声时才使用 `--min-component-area`，不要默认删除断开部件。
4. 每个候选都必须使用唯一的临时输出路径和独立 `--artifacts-dir`，不得在复查完成前覆盖当前最佳结果或最终交付文件。读取 JSON 后依次查看 light、dark、checker、alpha、mask 和 trimap。
5. 整图预览只能检查整体主体，不能证明细孔洞干净。必须对细线、孔洞、交叠处、主体边缘、分离部件以及用户标注区域生成 `2-4x` 局部放大图，并在 light、dark、checker 三种底色下逐项检查。全图看不见的数像素背景块仍视为失败。
6. 根据复查结果自主调整：封闭背景岛增加内部背景点或精确 mask；背景残留提高容差或增加背景提示；细部误删降低容差、缩小硬约束或增加前景提示；色边使用背景路线的去污染。只要硬约束覆盖了前景，就废弃该候选，不在错误掩码上继续叠加修补。
7. 选择同时满足主体完整、所有应透明孔洞透明、边缘无明显背景色、尺寸不变的结果。最后才写入最终输出路径，并重新读取最终文件验证 RGBA、尺寸、透明角点和局部放大预览。`review` 只表示 agent 还必须完成本节复查，不表示需要用户确认。

只有以下情况才询问用户：多个对象的主次无法从上下文判断，或水印、阴影、倒影、特效的归属会改变交付结果。一般的参数选择、候选比较和质量复查由 agent 自主完成。

### 5. 运行并生成复查材料

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
python scripts/cutout.py --input input.jpg --output output.png --mode grabcut --subject "人物和头发" --rect 40,20,720,900 --foreground-region 150,300,80,120 --background-region 420,500,30,24 --foreground-polygon "150,300;190,300;205,340;160,360" --background-polygon "420,500;450,500;445,530;425,525" --foreground-mask foreground.png --background-mask background.png --opaque-subject --foreground-threshold 144 --edge-inset 1 --artifacts-dir artifacts --json
```

### 6. 查看结果并迭代

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
- `--opaque-subject`：适用于 `background` 或 `grabcut` 生成的完全不透明主体；会恢复主体内部 RGB、只保留外轮廓抗锯齿，并处理边缘色污染。它会填补面积不超过图像 `0.01%` 的封闭孔洞，因此带有弓弦、箭羽、发饰、镂空装饰或其他细小背景岛的主体默认禁用，除非逐孔复查证明不会误填。禁止用于玻璃、烟雾、薄纱等半透明材质。
- `--foreground-threshold`：只用于 `--opaque-subject`，默认 `128`；提高会收紧用于精修的主体区域，需检查细部是否被削弱。
- `--edge-inset`：只用于 `--opaque-subject`，默认 `0`；向内收缩确认的前景轮廓，适合去除混色边，值越大越容易削弱细部。
- `--min-component-area`：只用于 `--opaque-subject`，默认 `0`；删除小于该面积的非连通前景组件。只有视觉确认小组件是噪声时才设置，例如本组图像使用 `32`；默认不删除，以保留多部件主体。
- `--subject`：生成新 Alpha 时必填，且不能是空白字符串；保留已有 Alpha 时可以省略。
- `--artifacts-dir`：生成新 Alpha 时必填，确保智能体能够执行视觉复查；保留已有 Alpha 时可选。
- `--rect`、`--foreground-region`、`--background-region`、`--foreground-polygon`、`--background-polygon`、`--foreground-point` 和 `--background-point` 均可重复。region/polygon 是局部确定硬约束，mask 用于更复杂的不规则精细修正。
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
