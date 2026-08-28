# P3 DOCX 跨运行范围替换

当前 P3 增加 `replace_text_range`，用于替换同一正文段落中跨越两个或更多 ordinary text run 的连续文本范围。操作目标包含 paragraph ID、起止 run ID 和 UTF-16 offset；预条件绑定 document revision、所选文本及其 SHA-256。

## 语义

- 起止 run 必须属于同一 direct body paragraph，顺序严格递增。
- 起始 offset 必须位于起始 run 内，结束 offset 必须大于零；边界不得切开 UTF-16 surrogate pair。
- 所有涉及 run 都必须满足现有 `editable` 资格。书签、批注、字段、修订、content control、超链接、drawing、textbox、foreign namespace、复杂 run 或不支持的 paragraph boundary 继续 fail-closed。
- replacement 写入起始 run 并继承其 run properties；起始前缀和结束后缀保留，中间 run 文本置空。run 元素及其 properties 不删除、不合并。
- 每个涉及 run 产生独立、带 preimage SHA-256 的 byte patch。计划公开逐 run semantic diff，但不向 Desktop renderer 或 Agent 暴露 patch manifest。
- 单个计划最多触达 100 个 run；范围在切片、XML 重写、base64 和哈希分配前执行该预算检查。planner 预建 run 顺序索引，commit 复用已解码 replacement 并对全部 patch 单次分配、单遍复制主 XML，避免 range fan-out 造成超线性扫描和整文档重复复制。
- 提交重新 inspect 并 canonical 重建计划，验证全部 patch，按有序 byte ranges 单遍重写 main document ZIP entry，然后 reopen 验证每个 touched run。

## 集成边界

Agent 的 `office_document_plan` 接受结构化范围和精确 `expectedText`，扩展在本地计算范围 SHA-256；Agent 不能提交。renderer 继续展示每个受影响 run 的 before/after 和 touched part，并仅用私有 plan handle 与精确 `planSha256` 批准提交。

## 验证

- 合成测试覆盖三 run 局部替换、XML escaping、run style 保留、surrogate 边界、逆序/同 run/空边界、blocked paragraph、schema 与 plan tamper。
- corpus 使用 LibreOffice core 固定提交 `03762554ad40639b2286f86e3016591c3ac24137` 的 `open-as-read-only.docx`：LibreOfficeDev 6.2 生成，同一 direct body paragraph 包含四个可编辑 run，且 creator/lastModifiedBy 元数据为空。测试跨三个 run 执行 roundtrip，证明仅 `word/document.xml` entry 变化；其余 entries（包括保存 `_MarkAsFinal` 的 `docProps/custom.xml`）内容保持一致。
- Desktop 测试覆盖 Agent 计划、非当前文档计划忽略、renderer 精确 `documentId`/`planId`/`planSha256` 批准、显式 discard、原子保存、reopen 和 native render diff。

当前环境没有 `libreoffice`/`soffice` 或 Microsoft Office，因此“修改后的输出由外部 Office 应用重新打开”仍需在带相应应用的互操作环境执行，不能由 producer corpus roundtrip 替代。
