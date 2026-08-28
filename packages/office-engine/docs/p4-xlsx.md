# P4 原生 XLSX 最小增量

P4 选择 XLSX。首个增量提供 worksheet 检查和现有非公式 cell 的事务化文本写入，不提供电子表格计算或结构编辑。

## 支持范围

- resolver 从 package root 的唯一 officeDocument relationship 定位非宏 workbook，并从 workbook relationships 解析内部 worksheet 与可选 sharedStrings。
- inspection 返回有界 sheet 元数据；首个 sheet 的初始 preview 最多携带 500 个 cell，renderer 按可见区间通过 owner-bound inspect IPC 分批加载，稳定 cell ID 为 `<worksheet relationship id>:<A1 address>`。
- `set_cell_value` 只接受 inspection 返回的现有 cell，并要求 sheet/cell/address、revision、旧值和 SHA-256 全部匹配。
- 一个计划只能触达一个 worksheet。写入保留现有 style ID，将目标 cell 局部改为 `inlineStr`；其他 ZIP entry 和 sharedStrings 原字节不变。
- commit 重新生成 canonical plan、验证 plan hash 与 patch preimage，通过 raw-copy archive 只替换目标 worksheet，并在 reopen 后复验语义 diff。

## Fail-closed 边界

以下情况拒绝 inspection 或 operation：外部/重复 relationship、package-root escape、宏 workbook content type、worksheet/sharedStrings content type 缺失或不匹配、DTD/PI、非法 namespace、非法 XML 字符、非 `worksheet/sheetData/row/c` 层级或 row/address 不一致的 cell、重复或超出 Excel 上限的 A1 cell、未知或外来 cell 子结构、未建模或外来 cell 属性、缺失 cell、公式 cell、error/不支持 cell、创建 row/cell/sheet、跨 worksheet transaction、sharedStrings 写入、样式编辑和结构增删。workbook 最多 100 sheets、200,000 cells；单次 Agent 或 renderer inspection 最多返回 500 cells。

## Desktop 与 Agent

`.xlsx` 不再进入 OfficeCLI。Desktop 使用独立 `XlsxDocumentService`，通过统一原生 Office facade 接入既有 IPC、原子文件替换、审计和 renderer-only approval。renderer 提供 worksheet tabs、纵向虚拟化 grid、公式只读状态、cell 编辑和精确 diff；最多显示 10,000 行与 26 列，初始 preview 和后续可见区间都按最多 500 cells 有界传输。文档 registry 与 DOCX 一样执行 owner 隔离、容量/LRU/idle 回收、单次计划和提交锁。

Agent 使用同一 `office_document_inspect` / `office_document_plan`：先请求 `sheets`，再用 `cells` + A1 range 或 `search-cells` 有界读取；只可生成 `set_cell_value` plan，不能 commit。

## Corpus 与门禁

`test/corpus-xlsx/simple-normal.xlsx` 固定自 Apache POI commit `87cdef57b0f714369c391e625180a59507a24576`，SHA-256 为 `6b300c76d7b6ba32e45c40086f5c8cea4b269946f7786a73e0d6f08c3acfe1e4`，producer 为 Microsoft Excel `14.0300`，Apache-2.0 LICENSE/NOTICE 随 corpus 保存。corpus manifest、fixture hash、producer metadata 和法律文件 hash 由共享 admission gate 同时用于测试与互操作生成。

`xlsx-interop:*` 生成固定 existing-cell 用例。hosted LibreOffice Calc 与 self-hosted Microsoft Excel 都必须重开保存、通过 cell 语义复验，并对保存前后 PDF raster 做页数与像素比较；Excel COM 打开显式使用 `xlNormalLoad`，不启用 repair/extract 模式，并要求应用路径包含 Microsoft Corporation 发布的 `EXCEL.EXE`，ProgID 兼容的替代办公套件会 fail closed。任一应用缺失、身份不符、repair、保存失败或视觉阈值超限都阻塞发布。确定性性能门禁另外覆盖 10,000-cell worksheet 的 inspect 与 plan/commit/reopen，并将实测 baseline 与失败阈值分离。当前本机没有 Microsoft Excel，实际动态证据仍须由 CI lane 产出。
