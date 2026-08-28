# P3 DOCX 页眉、页脚与批注编辑

P3 支持检查和替换现有页眉、页脚及批注中的普通文本 run。该能力只修改已经存在的 XML part，不创建或删除 relationship、content type、批注锚点或批注记录。

## 操作边界

- `replace_related_text_run` 仅接受 `header` 或 `footer`，并要求原样复述 inspection 返回的 `relatedPartId`、paragraph/run ID、revision、文本与 SHA-256。
- `replace_comment_text_run` 仅接受 `comments`，并要求原样复述 `commentId`、paragraph/run ID 与相同前置条件。
- 正文中的 comment range/reference 继续标记为 `comment-boundary`，不能通过批注操作绕过。
- 字段、书签、修订、批注引用、复杂 run、外部 namespace、CDATA、XML comment 和非直属段落结构保持 fail-closed。
- 批注的 annotation reference run 只读；同段中独立的普通文本 run 可以编辑。新增、删除和移动批注不在当前范围。

## 事务与产品集成

resolver 只暴露主文档直接 relationship 安全解析出的 header/footer/comments part。计划按物理 part 分组 patch；commit 对每个 part 验证 preimage、精确单 entry delta，并在最终 package reopen 后复验所有语义 diff。未触及 part 保持原字节。

Desktop RenderTree 分区展示页眉、正文、页脚和批注。Agent inspection 默认不返回批注；只有显式请求 `comments` part 才返回有界批注段落、作者和稳定 ID。Agent 仍只能生成 plan，所有修改继续通过 renderer 的精确 diff 与用户确认提交。

## 验证

- 引擎测试覆盖同一计划跨 header/footer part、XML escaping、未触及 entry 保留、现有批注正文替换、正文锚点不变和 commit 后稳定 ID/reopen。
- corpus 收录 Apache POI 的 Microsoft Word `HeaderFooterUnicode.docx`，固定 commit、SHA-256、Apache-2.0/NOTICE 和 producer metadata；已有真实 `comments.docx` 覆盖批注。
- 外部互操作矩阵包含 header+footer 双 part 和 comment text 两个案例。LibreOffice/Word runner 会重开保存、执行语义 probe，并比较输入/输出 PDF raster。
- Desktop 测试覆盖按 part 筛选、默认批注不披露、Agent plan、renderer 展示、approval 和保存后刷新。

实现侧测试已通过；发布仍要求 hosted LibreOffice 和配置的 Microsoft Word runner 对当前 commit 产出成功证据，不能用引擎自身 reopen 替代。
