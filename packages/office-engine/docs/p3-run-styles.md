# P3 DOCX Run 样式编辑

当前 P3 增加 `set_text_run_style`，仅修改普通可编辑 text run 的 `bold` 和 `italic`。操作以 revision-local paragraph/run ID、完整 run 文本及 SHA-256、当前完整样式摘要作为前置条件。

## 语义与保真

- `replacement` 至少指定 `bold` 或 `italic` 之一；没有实际状态变化的计划被拒绝。
- `expectedProperties` 必须包含当前 `bold`、`italic`，并在存在时包含 `styleId`。样式摘要不一致时返回 precondition failure。
- 已有 `w:b`/`w:i` 只替换对应元素的原始 byte slice；不存在的属性插入到 `w:rPr` 关闭标签前。
- 没有 `w:rPr` 时，在 run opening tag 后插入最小 `w:rPr`；自闭合 `w:rPr` 展开为普通元素。
- 生成 XML 复用已解析和验证的 run QName prefix，同时支持 transitional 与 strict WordprocessingML namespace。
- `w:rPr` 自身的属性、`w:rStyle`、颜色及其他未知 property 子节点保持原字节。重复 `w:rPr`、`w:b`、`w:i` 或非法 on/off 值标记为 `invalid-run-property`，不猜测修改。
- 同一计划中，同一 run 的文本和样式操作不能重叠。计划通过 `run_style` patch、touched run 和结构化 before/after properties diff 进入 canonical plan 与 `planSha256`。

## 集成边界

Agent 的 `office_document_inspect` 返回当前 run properties；`office_document_plan` 可创建样式计划，但不能批准或提交。renderer 审批面板以“粗体/斜体：开 → 关”展示精确变化，并继续只提交私有 `documentId`、`planId`、`planSha256`。

## 验证

- 引擎测试覆盖已有/缺失/自闭合 `w:rPr`、strict namespace、未知属性保留、无操作拒绝、重复属性阻断和 commit 后 reopen 属性校验。
- Desktop 测试覆盖 Agent host bridge、结构化 diff、renderer-only approval 与保存后 RenderTree 属性刷新。

当前环境没有 LibreOffice 或 Microsoft Office。修改输出的外部 Office 重开仍是发布门禁，不能由引擎自身 reopen 代替。
