# Office 文档引擎规范

状态：Draft
最后更新：2026-08-26
适用范围：`packages/office-engine`、`packages/desktop`

## 1. 背景

Desktop 当前通过 `pi-officecli` 将 Project 内的 `.docx`、`.xlsx` 和 `.pptx` 转换为隔离 HTML，只提供只读预览：

```text
Project file
  -> main OfficeDocumentPreviewService
  -> OfficeCLI view ... html
  -> cached HTML
  -> sandboxed renderer iframe
```

这是一条待替换的旧链路，不是新引擎的组成部分或长期回退方案。

下一阶段需要用自有 Office 引擎完整承担解析、渲染、结构化编辑和保存，并支持 AI 执行可验证、可审计、可回滚的操作。该能力不能建立在 HTML 预览、模型生成完整 OOXML 或 renderer 直接修改 ZIP 的基础上。

GenOffice 源码评估表明，以下设计具有参考价值：

- 原始 OOXML package 是唯一格式真源；
- 未修改 ZIP entry 和 XML slice 尽量原样保留；
- 修改只作用于 dirty fragment；
- 保存前校验 touched-entry manifest，出现意外变化时 fail closed；
- Agent 只提交结构化 operation，不直接生成 XML；
- render model 与编辑模型分离。

但 GenOffice 的引擎包仍是 `private`、`0.1.0` 的内部 TypeScript source package，存在跨包深层导入、过宽 API、真实 Office 互操作门禁不足等问题。本项目不直接依赖或整仓 fork GenOffice。

## 2. 目标

1. 建立可独立测试、与 Electron 和 React 无关的 Office 文档引擎。
2. 将原始 OPC/OOXML package 作为格式权威来源，不从渲染结果反向生成文档。
3. 未修改保存必须返回原始 bytes；局部修改不得意外改变未声明的 package parts。
4. Agent 编辑必须经过结构化 operation、前置条件、事务规划、diff 确认和原子提交。
5. renderer、Agent 和插件不得直接访问原始 XML 或可变引擎对象。
6. 首个 DOCX 垂直切片形成“打开、检查、规划、确认、保存、重开”的完整闭环。
7. 用真实 Office corpus 和自动门禁持续定义兼容性，而不是以功能列表代替正确性证据。
8. 为后续 PPTX、XLSX 复用 package、安全、事务和 corpus 基础，不提前抽象格式专属语义。
9. 按格式用自有解析与 RenderTree 替换 OfficeCLI，最终删除 OfficeCLI 二进制、下载、执行、HTML 缓存、IPC 和插件依赖。

## 3. 非目标

首期明确不做：

- 完整 Word、PowerPoint 或 Excel 替代品；
- DOCX 分页排版编辑器或像素级 Word renderer；
- PPTX、XLSX 写入；
- 旧版 `.doc`、`.xls`、`.ppt`；
- VBA、ActiveX、OLE、Power Query 或宏执行；
- 模型直接生成 OOXML、XPath、JavaScript 或压缩包；
- 多人协同、OT、CRDT 或跨进程共享可变文档对象；
- 首期同时实现 DOCX、PPTX 和 XLSX；
- 在同一格式上长期保留 OfficeCLI 与自有 renderer 双轨；
- 为尚未实现的格式建立统一大模型或通用 shape/cell/block 继承树。

## 4. 核心决策

### D1：新建独立 `packages/office-engine`

引擎是纯 TypeScript workspace package，不依赖 Electron、React、assistant-ui、Pi runtime、Node 文件系统或 ProjectStore。首期仅实现 DOCX，但目录和公共 API 不以 Desktop 私有状态为中心。

```text
packages/office-engine/
  src/
    opc/             OPC/ZIP package、关系、content types 与安全校验
    docx/            DOCX parse、raw slice、模型与 patch
    model/           对外只读 snapshot 与稳定引用
    operations/      operation schema、前置条件与 planner
    transactions/    revision、plan、diff 与 commit
    render/          与 UI 无关的只读 render tree
  test/
    fixtures/
    corpus/
```

在第二种格式真正接入前不拆成 `docx-engine`、`pptx-engine`、`xlsx-engine` 三个 package。

### D2：Desktop main 是文件与事务的权威层

`packages/office-engine` 只接收和返回 bytes。以下职责属于 Desktop main：

- 解析并限制 Project 相对路径；
- 文件读取、权限与大小限制；
- 维护打开文档、revision 和 transaction registry；
- 检测磁盘文件是否在事务期间被外部修改；
- 请求用户确认 diff；
- 临时文件、fsync、原子 rename 与失败清理；
- 保存后通知 file watcher，并使原生 RenderTree 和文档视图刷新。

renderer 和 Agent 使用 typed contract；二者都不持有引擎内部对象。

### D3：原始 package 是唯一格式真源

打开文档后，引擎同时持有：

- 原始文件 bytes；
- OPC entry manifest；
- 解析后的最小语义模型；
- 可定位到原始 XML 的 slice/anchor；
- 未建模 XML 与关系的 opaque 数据。

语义模型用于检查和寻址，不能成为保存整个文件的模板。未知 OOXML 必须默认保留，而不是默认丢弃。

### D4：operation 不暴露 OOXML

Agent 只能提交受版本控制的判别联合。当前协议包含精确 run 替换、同段跨 run 范围替换和直属正文段落插入/删除：

```ts
export interface TextPrecondition {
  documentRevision: number;
  expectedText: string;
  expectedTextSha256: string;
}

export interface ReplaceTextRunOperation {
  type: "replace_text_run";
  target: {
    part: "document";
    paragraphId: string;
    runId: string;
  };
  precondition: TextPrecondition;
  replacement: string;
}

export interface ReplaceTextRangeOperation {
  type: "replace_text_range";
  target: {
    part: "document";
    paragraphId: string;
    start: { runId: string; offset: number };
    end: { runId: string; offset: number };
  };
  precondition: TextPrecondition;
  replacement: string;
}

export interface InsertParagraphAfterOperation {
  type: "insert_paragraph_after";
  target: { part: "document"; paragraphId: string };
  precondition: TextPrecondition;
  replacement: string;
}

export interface DeleteParagraphOperation {
  type: "delete_paragraph";
  target: { part: "document"; paragraphId: string };
  precondition: TextPrecondition;
}

export interface SetTextRunStyleOperation {
  type: "set_text_run_style";
  target: { part: "document"; paragraphId: string; runId: string };
  precondition: TextPrecondition & {
    expectedProperties: { bold: boolean; italic: boolean; styleId?: string };
  };
  replacement: { bold?: boolean; italic?: boolean };
}

export type DocumentOperation =
  | ReplaceTextRunOperation
  | ReplaceTextRangeOperation
  | InsertParagraphAfterOperation
  | DeleteParagraphOperation
  | SetTextRunStyleOperation;

export interface DocumentOperationEnvelope {
  protocolVersion: 1;
  operations: readonly DocumentOperation[];
}
```

`protocolVersion` 只存在于 envelope，未知版本直接拒绝。`paragraphId` 和 `runId` 在同一次打开文档的 revision 内稳定。首期不承诺跨重新打开仍保持相同 ID；持久化 durable identity 必须在有真实需求和 corpus 证据后再设计。

### D5：规划与提交分离

任何写入都分两步：

```text
operations
  -> validate schema
  -> validate revision and preconditions
  -> plan transaction
  -> produce semantic diff + touched parts
  -> user/host approval
  -> commit exact plan
  -> serialize bytes
  -> validate package
  -> atomic file replace
  -> reopen and verify
```

`plan` 是不可变对象，绑定 `documentId`、base revision、源文件 SHA-256、operation envelope、diff 和 touched-entry manifest。main 对该对象的 canonical serialization 计算 `planSha256`；任何字段变化都会生成不同 hash。

Agent 只能创建 plan，不能批准或提交。renderer 展示该 plan 后，由用户操作触发 renderer 专属 IPC `approveAndCommit(transactionId, planSha256)`。main 必须验证调用方 renderer owner、Project、transaction owner、当前 revision、源文件 fingerprint、expiry 和 `planSha256`，先将事务转为 `approved`，再在同一个受信调用内执行私有 commit。该 IPC 不暴露给 preload 之外的页面，也不映射为 Agent 工具。

提交时任一绑定条件变化都必须拒绝，不自动重放、猜测合并或接受另一个 plan 的批准。批准是一次性的；无论 commit 成功或失败，均不能复用。

### D6：保存 fail closed

保存器必须证明实际 delta 与已批准 plan 精确一致：

- 无 operation 时直接返回原始 `Uint8Array`；
- plan 中每一个修改必须发生，不能只应用子集；
- 每个 patch 绑定修改前 XML anchor 的 byte range 与 SHA-256，序列化前重新校验；
- 只有 plan 声明的 byte range/XML slice 可以变化；同一 touched part 内的其他 bytes 也必须保持不变；
- 其他 entry 不得丢失、新增或改变内容；
- 可行时保留未修改 entry 的原始压缩数据与 metadata；
- content types、relationships 和目标 part 必须保持内部一致；
- 保存后重新计算 actual delta，并与 plan 中有序 patch manifest 逐项相等；
- 生成结果必须能被本引擎重新打开；
- 任一计划修改缺失、额外 byte 变化或校验失败时不得覆盖源文件。

首个实现前必须验证现有 `fflate` 是否能提供 raw entry copy 和所需 metadata。不能因为仓库已有依赖就假定它满足 byte-preserving save；若不满足，先评估成熟库，再决定是否实现最小 OPC writer。

### D7：按格式原子替换 OfficeCLI

自有引擎最终承担 `.docx`、`.pptx` 和 `.xlsx` 的解析、渲染、编辑与保存。OfficeCLI 只作为迁移前的现状存在，不进入目标架构，也不作为新引擎失败时的兼容回退。

迁移按格式执行：

1. 自有引擎完成该格式的 PackageArchive、DocumentModel、RenderTree 和只读视图；
2. corpus、性能和安全门禁达到该格式的切换标准；
3. 在同一个交付中将该格式的预览调用切到自有引擎，并删除对应 OfficeCLI 分支；
4. 第一个格式迁移时整体撤下 `pi.officecli` 的 Agent tools 和 Marketplace 产品入口，避免其通用 `office_*` 工具绕过原生 operation/approval；
5. 迁移后的格式不再尝试 OfficeCLI，失败时展示结构化错误；
6. DOCX、PPTX、XLSX 全部迁移后，删除 OfficeCLI 全部下载、定位、执行和配置代码。

OfficeCLI 的 Agent 能力不按格式做临时兼容拆分。第一个格式迁移后，其二进制只能作为 Desktop 内部实现，服务尚未迁移格式的只读预览；不再向 Agent 注册 OfficeCLI 工具。同一种格式不得由两套 renderer 长期并存或根据失败自动切换。

## 5. 六层架构

### 5.1 `PackageArchive`

职责：安全读取、索引和写回 OPC ZIP package。

必须提供：

- entry 名称规范化和重复名称拒绝；
- `..`、绝对路径、反斜杠歧义与 NUL 拒绝；
- entry 数、单 entry 解压大小、总解压大小和压缩比限制；
- encrypted entry、unsupported compression 和 CRC 错误拒绝；
- `[Content_Types].xml` 与 `_rels/.rels` 定位；
- 从 package root relationships 中解析内部 `officeDocument` relationship，并将其规范化 target 作为主文档 part 的唯一权威路径；外部 target、越界 target、缺失或多个候选均拒绝；
- 原始 entry bytes、压缩数据、顺序和必要 metadata 的保留能力；
- touched-entry manifest 与保存后差异报告。

`PackageArchive` 不理解 paragraph、slide 或 cell。

首期默认限制由 corpus 测量后固化，配置只能向更严格方向覆盖；不得允许 Agent 放宽限制。

### 5.2 `DocumentModel`

职责：提供格式专属、只读、最小充分的语义快照。

DOCX 首期模型只包含：

- main document part；
- body 中的 paragraph；
- paragraph 内的 text run；
- 每个 run 的文本、基础属性摘要和原始 anchor；
- section、table、drawing、field、revision 等未支持内容的 presence/opaque 标记。

```ts
export interface DocxTextRunSnapshot {
  id: string;
  text: string;
  properties: {
    bold?: boolean;
    italic?: boolean;
    styleId?: string;
  };
  editable: boolean;
  blockedReason?: string;
}
```

遇到 tracked changes、field code、content control、drawing text、复杂 hyperlink 或不安全边界时，首期将对应 run 标记为不可编辑，而不是降级修改。

### 5.3 `Operation`

职责：表达用户或 Agent 的意图，而不是文件实现细节。

规则：

- schema 有显式 `protocolVersion`；
- 每个 operation 有精确 target 和 precondition；
- 输入大小、字符串长度和 operation 数量有限制；
- 纯校验，不读文件、不执行脚本；
- 未知 operation type 直接拒绝；
- operation 不能携带 XML、relationship ID、ZIP path 或代码。

后续操作按真实需求逐项增加，例如 paragraph insert、range replacement、comment 和 style mutation；不以一个通用 `patch` operation 绕过类型边界。

### 5.4 `Transaction`

职责：将 operation 映射为确定性变更计划。

事务状态固定为：

```text
opened -> planned -> approved -> committed
                   -> rejected
       -> stale
       -> failed
```

不在代码中使用 TypeScript `enum`；使用字符串联合。每次 plan 必须返回：

- semantic diff；
- touched runs、XML slices 和 package entries；
- warnings 与 blocked operations；
- source hash、base revision 和 expiry；
- commit 后的新 revision。

事务不能部分提交。多个 operation 中任意一个失败，整批 operation 不产生输出 bytes。

### 5.5 `Renderer`

Renderer 是引擎的正式层，不是外部 CLI 的适配器。它将格式专属 `DocumentModel` 转成纯数据 `RenderTree`：

```ts
export interface DocumentRenderTree {
  documentId: string;
  revision: number;
  format: "docx";
  root: RenderDocumentNode;
  warnings: readonly RenderWarning[];
}
```

DOCX 首个切片实现连续流式文档视图，不承诺与 Word 相同的分页；分页差异必须明确记录在 `warnings`，不能伪装成格式保真。RenderTree 的节点引用复用 DocumentModel 的稳定 ID，使用户选择、diff 高亮和 Agent target 指向同一语义对象。

renderer 进程只消费 structured-clone-safe RenderTree，并负责布局展示、选择、diff 和审批。它不解析 XML，不将 DOM 位置当成文档 target，也不从渲染 DOM 生成 operation。

格式切换到自有引擎后，预览、编辑和保存必须共享同一 DocumentModel；不得再生成 OfficeCLI HTML 或挂载 Office 文档 iframe。

### 5.6 `CompatibilityCorpus`

职责：把格式兼容性转成可重复的证据和门禁。

Corpus 分类：

- `minimal`：代码生成的最小合法文件；
- `real-world`：经过来源和许可审计的真实文件；
- `producer`：Microsoft Office、LibreOffice、Google Docs、WPS 等不同 producer；
- `adversarial`：zip bomb、路径穿越、重复 entry、损坏关系、超大 XML；
- `feature`：表格、图片、批注、修订、域、目录、CJK、RTL、公式等；
- `regression`：每个已修复兼容问题的最小样本。

每个 fixture 必须有 sidecar manifest，记录来源、许可证、producer/version、特征、预期能力、敏感信息清理和允许进入仓库的依据。

## 6. Desktop 集成

目标链路：

```text
Renderer diff/approval UI ─ typed IPC ┐
                                      v
Agent office tools ─ typed host bridge -> OfficeDocumentService (main)
                                         -> packages/office-engine
                                         -> Project path guard
                                         -> transaction registry
                                         -> atomic file writer
                                         -> file watcher / native view refresh
```

### 6.1 Main service

计划新增：

```text
packages/desktop/src/main/files/office-document-service.ts
```

该 service 负责：

- `open(projectId, path)`；
- `inspect(documentId, query)`；
- `plan(documentId, envelope)`；
- `approveAndCommit(rendererOwner, transactionId, planSha256)`，仅供 renderer IPC adapter 调用；
- `reject(owner, transactionId)`；
- `close(documentId)`；
- renderer owner 销毁、Project 移除或超时后的资源回收。

打开 registry 只能缓存受限数量和总 bytes，使用 LRU/idle timeout；源文件 bytes 不通过 IPC 返回。

### 6.2 Shared contract

Office 编辑契约放在独立文件，而不是继续扩大 `contracts.ts`：

```text
packages/desktop/src/shared/office-document-contracts.ts
```

IPC 只传 structured-clone-safe DTO。错误使用稳定 code，例如：

- `UNSUPPORTED_FORMAT`
- `UNSAFE_PACKAGE`
- `STALE_DOCUMENT`
- `PRECONDITION_FAILED`
- `OPERATION_BLOCKED`
- `VALIDATION_FAILED`
- `TRANSACTION_EXPIRED`

用户可见中文文案由 Desktop adapter 映射；引擎不包含产品文案。

### 6.3 Agent 工具

首个切片向 Agent 提供两类工具能力：

- 检查文档结构与可编辑 run；
- 规划一组 operation 并返回不可变 plan、`planSha256` 和语义 diff。

Agent 工具必须复用 main 的 `OfficeDocumentService`，不得另起一套文件读写实现。工具结果不返回原始 XML、整个文档正文或未请求的敏感内容。

批准和提交不是 Agent 工具。只有拥有该文档视图的 renderer 可调用 `approveAndCommit`；main 在受信边界内完成批准状态转换和私有 commit。

### 6.4 OfficeCLI 删除清单

DOCX 切换交付必须删除或收敛以下 DOCX 旧路径：

- `packages/desktop/src/main/files/office-document-preview-service.ts` 中的 DOCX 分支；
- `filesPreviewOfficeDocument` 返回 HTML 的 DOCX 契约与 renderer iframe 分支；
- DOCX HTML cache、取消请求和相关测试；
- `pi.officecli` 的全部 Agent tools、Marketplace 产品入口和已托管插件版本；
- `packages/desktop/src/main/index.ts` 中将 `pi.officecli` 配置用于 DOCX 的 host 路径；
- 已安装 managed `pi.officecli` 的 reconciliation：撤下工具注册但保留未迁移格式的内部只读 binary 配置；
- `packages/desktop/src/main/pi/skills/plugin-publish/scripts/spec.example.json` 中的 OfficeCLI 发布样例。

当最后一个 Office 格式迁移后，完整删除：

- `packages/desktop/src/main/files/office-document-preview-service.ts`；
- `packages/desktop/src/main/files/office-cli-binary.ts`；
- OfficeCLI binaryPath、dataDir、version、autoDownload 配置；
- OfficeCLI 安装、校验、下载镜像和缓存清理逻辑；
- `OfficeDocumentPreview { html }`、对应 preload API、IPC channels 和 iframe renderer；
- 仅用于 OfficeCLI 的插件声明、测试和文档。

删除发生在新链路通过验收的同一阶段，不增加兼容 wrapper 或 fallback。

## 7. DOCX 首个垂直切片

### 7.1 支持范围

- 输入：未加密 `.docx`；
- 主文档：由 package root `officeDocument` relationship 解析，target 必须存在、位于 package 内并具有受支持的 WordprocessingML content type；
- 检查：普通 body paragraph 和普通 text run；
- 编辑：一个或多个普通 text run 的完整文本替换、同一普通段落内的跨 run 连续范围替换、直属正文普通段落的插入/删除，以及普通 text run 的 bold/italic 样式；
- 保留：run properties、paragraph properties、所有未触及 XML slice、其他 ZIP entries；
- 输出：新的 `.docx`，保存后可由引擎重开；
- UI：自有 RenderTree 文档视图、结构化 diff、明确批准和保存结果；
- 渲染：首期连续流视图，展示普通 paragraph/text run，并对未支持结构给出明确占位与 warning。

### 7.2 阻断范围

以下 target 在首期必须返回 `OPERATION_BLOCKED`：

- tracked revisions 中的文本；
- field instruction/result 边界；
- content control 边界；
- hyperlink 跨边界替换；
- drawing、textbox、header/footer、footnote/endnote；
- 跨 paragraph 或穿越 blocked run 的 substring 替换；
- 对非直属正文或包含 blocked content 的 paragraph 执行插入/删除；
- 会改变关系、media、style、numbering 或 content types 的操作；
- 加密、带数字签名或无法验证完整性的 package。

阻断是产品正确行为，不得静默退化为重建 paragraph。

### 7.3 文本编码规则

替换必须正确处理：

- XML escaping；
- `xml:space="preserve"` 的增加和移除；
- 空文本 run；
- surrogate pair、组合字符和 CJK；
- `w:t` 多节点或非普通文本结构的拒绝；
- 原 run properties 和外围 XML 原样保留。

## 8. 保存与并发

Desktop 打开文件时记录：

```ts
export interface SourceFingerprint {
  size: number;
  mtimeMs: number;
  sha256: string;
}
```

commit 前必须重新读取源文件 fingerprint。发生变化时 transaction 进入 `stale`，要求重新打开、重新规划和重新确认。`mtimeMs` 只用于快速拒绝，最终并发判断以 SHA-256 为准。

原子保存必须使用可恢复的同文件系统替换原语，源文件在最终系统调用前始终存在。禁止先 `unlink`/删除源文件再 rename，也禁止在平台能力不足时退化为非原子覆盖。

通用顺序：

1. 读取并保存源文件安全相关 metadata，创建仅当前用户可访问的同目录随机临时文件；
2. 写入全部输出 bytes，flush 并关闭临时文件；
3. 重新打开临时文件，执行 package、actual delta 和 reopen 校验；
4. 再次验证源文件 SHA-256，并持有平台允许的写入/删除排他保护直至替换结束；
5. 执行保留可恢复 preimage 的平台原子替换；
6. 校验目标内容、权限/ACL、owner、基础属性和平台支持的扩展 metadata；
7. 同步父目录（平台支持时），再删除 recovery preimage；
8. 更新 revision，关闭该 transaction，广播文件变化；
9. 任一步失败都恢复或保留原文件，清理临时文件，并将 transaction 置为 `failed` 或 `stale`。

POSIX 实现必须使用同一 mount 的临时文件，保留 mode/owner，按 `write -> fsync(temp) -> close -> recoverable atomic replace -> fsync(directory)` 排序；不得把 `rename` 失败降级为 copy-overwrite。Windows 实现必须使用提供 replace + recovery preimage 的系统原语，并在 fingerprint 校验到替换完成期间阻止其他进程写入/删除；必须验证 DACL、owner、文件属性和 alternate data streams 的保留策略。网络文件系统或平台无法满足这些条件时保存必须 fail closed。

P2 开始前用故障注入分别证明 Windows 和 POSIX 在写入、flush、校验、替换和 metadata 恢复各阶段崩溃后，源文件或 recovery preimage 至少有一份完整有效。首期不创建长期备份；recovery preimage 只保留到 commit 验证完成。

## 9. 安全边界

- 所有 Office 文件均视为不可信输入；
- 不执行宏、OLE、外部模板、外部 relationship、field code 或嵌入脚本；
- 默认不解析外部 URL 内容；
- XML parser 必须禁用 DTD、entity expansion 和网络解析；
- ZIP 和 XML 均有独立资源预算；
- operation 数量、文本长度、diff 大小和事务存活时间有限制；
- Agent 不能控制临时目录、输出路径、package entry path 或资源限制；
- renderer 不接收源文件绝对路径和原始 package bytes；
- 错误日志不得包含完整文档正文；
- 进程崩溃、取消、超时和校验失败均不得留下半写源文件。

若 fuzz 或 adversarial corpus 证明纯进程内解析会威胁 main 稳定性，再将引擎迁入受限 worker/utility process；首期不预先增加进程协议。

## 10. 测试与质量门禁

### 10.1 单元测试

必须覆盖：

- OPC path、duplicate entry、size/ratio/CRC 限制；
- content types 和 relationships；
- DOCX paragraph/run slice 定位；
- XML escaping 与 `xml:space`；
- operation schema、revision 和 precondition；
- transaction 全有或全无；
- Agent commit 缺席、renderer owner 校验、`planSha256` 不匹配、重复批准和过期批准拒绝；
- touched-entry manifest；
- stale fingerprint 和 atomic-save failure cleanup。

### 10.2 Roundtrip 门禁

每个可接受 fixture 必须满足：

1. `open -> save(no operations)` 输出与输入整体 bytes 完全相同；
2. 单 run 修改后，未触及 entry 的内容 hash 完全相同；
3. PackageArchive 支持时，未触及 entry 的原始压缩数据和 metadata 完全相同；
4. 关系解析出的主文档 part 中，未触及顶层 slice 完全相同；
5. 保存结果可重新打开，目标 run 文本与预期一致；
6. 第二次无修改保存仍返回第一次保存 bytes。

### 10.3 互操作门禁

CI 分层执行：

- 所有平台：引擎 reopen、schema/package invariants、corpus roundtrip；
- 有 LibreOffice 的 lane：headless open/save 或导出 PDF，禁止 repair/error；
- Windows Office lane：Microsoft Word 打开、无 repair prompt、保存关闭；
- 视觉 lane：固定 producer、字体和渲染环境，将保存前后 PDF 页面做阈值化图像比较。

首期若 CI 环境尚无 Word lane，必须把它记录为 release blocker 或显式风险，不能用 `console.warn` 代替失败阈值。

### 10.4 覆盖率与回归

`packages/office-engine` 建立 statement、branch 和 function coverage threshold。具体数值在首个实现 PR 根据可达代码确定后写入配置，后续不得降低来修复失败。

每个数据损坏、意外格式变化或 Office repair warning 必须新增最小 regression fixture。

### 10.5 性能门禁

至少记录并限制：

- 10 MiB、50 MiB DOCX 的打开峰值内存；
- 1,000、10,000 paragraph 的 inspect 时间；
- 单 run edit 的计划和保存时间；
- 未修改保存不复制或重压整个文档；
- 大型恶意压缩包在预算内被拒绝。

性能阈值必须基于 CI runner 基线制定，报告值和失败阈值分开保存。

实现状态：`packages/office-engine/scripts/performance-gate.ts` 以固定 10/50 MiB payload、1,000/10,000 paragraph 和 10,000 paragraph 单 run transaction 执行预算检查；`performance-budget.json` 分离基线与失败阈值，`.github/workflows/office-interop.yml` 的 hosted performance job 上传独立报告并在越界时失败。详见 `packages/office-engine/docs/performance-gate.md`。

## 11. 可观测性与审计

每个 transaction 生成不含正文的审计记录：

```ts
export interface OfficeTransactionAudit {
  transactionId: string;
  projectId: string;
  relativePath: string;
  format: "docx";
  sourceSha256: string;
  outputSha256?: string;
  operationTypes: string[];
  operationCount: number;
  touchedParts: string[];
  planSha256: string;
  approvedAt?: number;
  approvalChannel?: "renderer_user";
  status: "planned" | "approved" | "rejected" | "committed" | "stale" | "failed";
  createdAt: number;
  completedAt?: number;
  errorCode?: string;
}
```

默认不记录 replacement 文本。若未来需要持久 undo，正文数据使用单独加密存储和保留策略，不塞入普通日志或 Pi timeline。

## 12. 许可证与来源管理

### 12.1 GenOffice

参考基线为 `genspark-ai/genoffice` commit `7eb5d59b59cc0765741645584eab2e587e6597f2`。

默认策略是参考架构、重新实现，不直接复制源码。若选择性复制 Apache-2.0 区域代码，实施 PR 必须同时：

- 记录原始文件、commit 和许可证；
- 保留适用版权与 NOTICE；
- 在修改文件中留下明显修改说明；
- 审计其 npm、Rust、字体、Unicode、Chromium、PDFium 和 vendored 来源；
- 移除 GenOffice/Genspark 名称、logo、应用图标和其他品牌资源；
- 不复制 `ee/` 内容。

GenOffice `ee/` 当前虽只有 LICENSE/README 且不进默认构建，其许可证仍不允许未授权生产、托管或分发。架构参考与源码复制必须作为不同审计对象。

### 12.2 本项目要求

- 新增第三方直接依赖前检查许可证、维护状态、已知漏洞和生命周期脚本；
- 依赖版本精确锁定；
- corpus 文件必须有来源 manifest；
- release artifact 必须显式包含本项目 LICENSE、NOTICE 和适用第三方 notices；
- 不能依赖 warning-only 的 notice 生成流程证明合规。

本节是工程合规要求，不构成法律意见。

## 13. 里程碑

### P0：Package 与安全基线

- 创建 `packages/office-engine`；
- 实现只读 `PackageArchive`、资源限制和 OPC manifest；
- 建立 minimal/adversarial fixtures；
- 完成无修改 byte-identical roundtrip；
- 完成 ZIP 库能力 spike，并记录 raw-copy 结论。

验收：安全测试、roundtrip 和 coverage gate 全绿。

### P1：DOCX 单 run 事务

- 解析普通 paragraph/text run 与 raw slice；
- 实现 inspect snapshot；
- 实现 `replace_text_run`、precondition、plan 和 semantic diff；
- 实现局部 XML patch、精确 patch manifest、actual delta 校验和 reopen；
- 增加 real-world/producer corpus。

验收：对支持范围内 fixture 完成精确修改，未触及内容通过保真门禁；阻断范围全部 fail closed。

### P2：Desktop 与 Agent 闭环

- 新增 `OfficeDocumentService` 和 shared contracts；
- 实现 stale detection 和 atomic save；
- 增加自有 DOCX RenderTree 与 renderer 文档视图；
- 增加 diff/approval UI 与 renderer-only `approveAndCommit`；
- 注册 inspect/plan Agent 工具；
- 保存后刷新文件状态和自有 RenderTree；
- 在同一交付中删除 DOCX 的 OfficeCLI HTML preview、iframe 和 cache 分支；
- 整体撤下 `pi.officecli` Agent tools、Marketplace 入口和托管插件版本，并完成 managed install reconciliation；
- 记录无正文 transaction audit。

验收：Agent 在真实 Project 中完成“检查 → 规划 → 用户确认 → 保存 → 重开 → 原生重新渲染”闭环，拒绝和失败路径不改变源文件；DOCX 运行路径不再调用或回退 OfficeCLI。

### P3：DOCX 编辑面扩展

按 corpus 和产品需求逐项增加跨 run range、paragraph insert/delete、comments、styles、headers/footers 等能力。每项能力必须同时增加 operation、blocked boundary、roundtrip、互操作和视觉测试。

当前状态：

- `replace_text_range` 已交付，详见 `packages/office-engine/docs/p3-cross-run-range.md`；
- `insert_paragraph_after` 和 `delete_paragraph` 已交付，详见 `packages/office-engine/docs/p3-paragraph-operations.md`；
- comments、headers/footers 已交付，现有纯文本 run 分别通过 `replace_comment_text_run` 与 `replace_related_text_run` 修改；正文批注锚点保持阻断，新增/删除批注不在当前范围，详见 `packages/office-engine/docs/p3-related-parts.md`；
- `set_text_run_style` 的 bold/italic 修改已交付，详见 `packages/office-engine/docs/p3-run-styles.md`；
- 已交付能力的引擎 roundtrip、Desktop 原生审批与定向视觉测试已覆盖；外部互操作门禁、八组确定性用例、LibreOffice hosted lane 和 Microsoft Word self-hosted lane 已实现，详见 `packages/office-engine/docs/external-interop-gate.md`。当前开发环境没有对应应用，因此本提交的发布门禁仍须以两个 CI lane 的成功结果和证据产物解除，不得以 producer fixture 的引擎 roundtrip 代替。

### P4：第二格式决策

P4 选择 **XLSX**。产品侧已有 `quarterly.xlsx`、`budget.xlsx` 等真实工作流，现有 OPC/raw-copy transaction 基础可直接复用；PPTX 的 shape、theme 和 layout 语义范围明显更大。

首个 XLSX 增量已交付，严格限制为：

- 固定来源 corpus、workbook/worksheet relationship resolver；
- 有界 sheet/range inspection，元素 ID 使用 sheet relationship ID 与 A1 地址；
- 仅修改现有、非公式 cell；写入局部 `inlineStr`，不创建 worksheet、row/cell、sharedStrings 或 package entry；
- 单 worksheet transaction、preimage/touched-entry/reopen 复验；
- Desktop 原生虚拟 grid、Agent inspect/plan、renderer-only approval；initial preview 最多携带 500 cells，renderer 可见区间通过 owner-bound IPC 分块读取；
- XLSX 路径完成后删除 XLSX OfficeCLI preview 分支，PPTX 暂时保留现有只读预览；
- LibreOffice Calc 与 Microsoft Excel 外部互操作为发布门禁。

实现、corpus、边界和运行命令详见 `packages/office-engine/docs/p4-xlsx.md`。引擎 roundtrip、Desktop/Agent/renderer 定向测试与自动化 lane 已交付；当前开发环境没有 Calc/Excel，因此发布仍须等待两个 CI lane 的实际成功结果与证据产物。

不实现公式引擎、公式 cell 写入、sharedStrings 修改、样式编辑或结构增删。

## 14. 验收标准

首个 DOCX 阶段完成必须同时满足：

1. `packages/office-engine` 不依赖 Desktop、Electron、React 或 Pi。
2. 无修改保存对所有支持 fixture 返回原始 bytes。
3. 单 run 修改只改变计划声明的 XML slice 和 package entry。
4. 磁盘外部修改、precondition 失败和 transaction 过期均阻止提交。
5. renderer 和 Agent 无法提交 XML 或绕过 operation schema。
6. Agent 只能生成 plan；用户在 renderer 对精确 `planSha256` 的批准由 main 验证并一次性提交，Agent 无 commit 能力。
7. 保存失败、取消和崩溃不破坏源文件。
8. 保存结果通过引擎 reopen、LibreOffice lane 和已配置的 Office 互操作门禁。
9. corpus 来源、许可证和特征 manifest 完整。
10. 新增定点测试、coverage gate、Desktop typecheck 和根 `npm run check` 全部通过。
11. DOCX 运行路径和 Agent tool registry 中不存在 OfficeCLI 调用、HTML preview 或失败回退。
12. XLSX 运行路径不存在 OfficeCLI 调用或 HTML fallback；PPTX 是唯一保留的 legacy HTML preview 格式。
13. XLSX 公式、缺失 cell、结构增删、跨 worksheet transaction 与 sharedStrings 写入全部 fail-closed。
14. XLSX 保存结果通过引擎 reopen、LibreOffice Calc lane 和已配置的 Microsoft Excel lane。

## 15. 开放问题

以下问题必须在对应里程碑开始前解决，不阻塞 RFC 合入：

1. 哪个 ZIP 库能够同时满足安全预算、raw entry copy、metadata preservation 和流式写入；
2. diff panel 的交互形态与放置位置；
3. Agent sidecar 到 main 的 typed host bridge 是否复用现有 Desktop host RPC；
4. corpus 中真实客户文件的脱敏、授权和本地-only 测试策略；
5. 首期是否需要内存内 undo，还是重新打开文件并生成反向 operation。

## 16. 实施前检查

开始 P0 前必须先提交一份短 spike 结论，回答：

- 现有 `fflate` 能否读取并原样复制未修改 ZIP entry 的压缩数据与 metadata；
- 候选 XML parser 是否默认禁用 DTD/entity/network；
- 候选库的许可证、维护状态、Node 22 支持和 bundle 影响；
- 10 MiB/50 MiB 样本的内存与耗时；
- Windows/POSIX 候选原子替换原语如何保留 recovery preimage、安全 metadata 并通过故障注入；
- minimal DOCX 在 Word、LibreOffice 和自有 RenderTree 中的打开结果；
- DOCX 切换后可删除的 OfficeCLI 调用、契约、配置和测试的完整依赖清单。

未完成该 spike 前不开始 Agent 工具或编辑 UI，以免在不可靠保存底座上叠加产品能力。
