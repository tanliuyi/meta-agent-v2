# P3 DOCX 段落插入与删除

当前 P3 增加 `insert_paragraph_after` 和 `delete_paragraph`，用于修改主文档 `w:body` 的直属普通段落。两种操作都以 revision-local paragraph ID 为目标，并以 document revision、目标段落完整文本及其 SHA-256 作为前置条件。

## 语义

- 目标必须是 `w:body` 的直属普通 `w:p`，且 paragraph 及其全部现有 run 必须满足现有 `editable` 资格。
- `insert_paragraph_after` 在目标段落结束 byte anchor 处插入一个最小 ordinary paragraph。非空 replacement 生成一个普通 run/text，XML 特殊字符被转义，首尾空白使用 `xml:space="preserve"`；空 replacement 生成空段落。
- 新段落使用目标段落已经解析并验证的 WordprocessingML QName prefix，因此同时支持 transitional 和 strict namespace，不猜测或重新声明 namespace。
- `delete_paragraph` 删除目标 `w:p` 的完整原始 byte slice；不重建相邻 paragraph、`sectPr` 或其他 body child。
- 同一计划可操作多个不同段落。结构操作不能与针对同一 paragraph 的 run/range 操作组合，也不能对同一 paragraph 重复执行结构操作。
- 插入使用 `start === end` 的零宽 patch，删除使用完整 paragraph byte range；两者都带 preimage/replacement SHA-256，并进入 canonical plan 与 `planSha256`。
- 删除计入原 paragraph 的 touched runs；插入不伪称修改目标 run。计划另外公开 `touchedParagraphs` 和逐段落 before/after semantic diff。
- 提交重新生成 canonical plan、验证 patch 和 preimage，仅重写 `word/document.xml`，随后重新打开输出。复杂段落、嵌套段落、超链接、修订、字段、content control、drawing、textbox 和 foreign namespace 继续 fail-closed。

## 集成边界

Agent 的 `office_document_inspect` 返回 paragraph `textSha256`；`office_document_plan` 接受两种段落 operation，但仍不能批准或提交。renderer 展示明确的“插入段落”或“删除段落”及精确文本差异，并只用私有 `documentId`、`planId`、`planSha256` 句柄批准。

Desktop 的 `DocumentRenderTree` 在保存后由重新 inspect 的 snapshot 构造，revision-local paragraph/run ID 随新 revision 重新生成。renderer 不通过 DOM 位置推导 operation target。

## 验证

- 引擎测试覆盖同一计划在相邻 byte boundary 插入和删除、strict namespace、CJK、XML escaping、首尾空白、准确 touched sets、reopen 和只改变主文档 entry。
- fail-closed 测试覆盖错误文本/hash、额外 schema 字段、非法 scalar、同段结构/文本冲突，以及 blocked paragraph。
- Desktop 测试覆盖 Agent host bridge、结构化 plan、renderer 精确 diff、renderer-only approval、原子保存和 native RenderTree reopen。

当前环境没有 `libreoffice`/`soffice` 或 Microsoft Office，因此修改输出的外部 Office 重开仍需在互操作环境执行，是发布门禁而不是已满足证据。
