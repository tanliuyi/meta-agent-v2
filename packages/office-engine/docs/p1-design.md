# P1 DOCX 实现说明

> P3 已在此基础上增加同段落跨运行范围替换，见 [p3-cross-run-range.md](./p3-cross-run-range.md)。本文件保留 P1 单运行能力的设计基线。

P1 实现提供纯 bytes DOCX 检查、结构化单 run 替换、计划和提交闭环。SHA-256 使用精确 pin 的 `@noble/hashes@2.3.0`；OOXML 事件解析使用 namespace-aware `saxes@6.0.0`，并通过一次性 UTF-16 到 UTF-8 偏移表产生 byte anchors。

可编辑范围严格限制为 main document body 的 direct paragraph、direct run、单个 direct `w:t` 纯文本叶节点。namespace 按 URI/localName 判定，Transitional 和 Strict 均支持。复杂子树、字段、超链接、修订、content control、批注/书签范围、drawing/table/textbox 以及 comment/CDATA/PI 均阻断并产生 warning；未知 Word namespace fail closed。

计划 DTO 只包含 immutable、structured-clone-safe 数据，patch replacement 使用 base64；canonical JSON 拒绝 undefined、非有限数、非 plain object 和循环。计划绑定 documentId、base/resulting revision、source hash、envelope、semantic diff、ordered patch manifest 和 expiry。提交重新验证这些绑定、patch preimage/hash，按反向 byte ranges 生成 XML，并 reopen 验证文本、ID 和 revision；空操作返回完全原始 bytes。

PackageArchive 保留 no-op 原始 bytes、entry 顺序与 untouched entry records/data。安全校验拒绝路径歧义、重复 entry、ZIP64、加密、CRC/metadata 不一致、限制越界，并支持带或不带 signature 的 ZIP data descriptor；签名通过 `_xmlsignatures` 路径及 content-types/relationships signature 类型拒绝。ZIP 改写仍只针对 touched entry，真实 Office producer 互操作与原子文件替换属于后续 P2 gate。
