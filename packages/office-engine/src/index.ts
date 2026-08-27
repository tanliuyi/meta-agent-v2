export {
	type ArchiveLimits,
	DEFAULT_ARCHIVE_LIMITS,
	normalizeOpcPath,
	PackageArchive,
	type PackageArchiveEntry,
} from "./archive.ts";
export {
	CONTENT_TYPES_NAMESPACE,
	type DocxMainPart,
	type DocxPackageResolution,
	resolveDocx,
	resolveDocxMainPart,
	STRICT_OFFICE_DOCUMENT_RELATIONSHIP,
	TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP,
	TRANSITIONAL_PACKAGE_RELATIONSHIPS_NAMESPACE,
	WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE,
} from "./docx.ts";
export {
	type DocxBlockedReason,
	type DocxDocumentSnapshot,
	type DocxParagraphSnapshot,
	type DocxPresence,
	type DocxRunProperties,
	type DocxTextRunSnapshot,
	type DocxUnsupportedKind,
	inspectDocx,
} from "./docx-document.ts";
export {
	DOCX_MAX_ENVELOPE_TEXT_BYTES,
	DOCX_MAX_ID_BYTES,
	DOCX_MAX_OPERATION_COUNT,
	DOCX_MAX_TEXT_BYTES,
	DOCX_OPERATION_PROTOCOL_VERSION,
	type DocumentOperation,
	type DocumentOperationEnvelope,
	type DocxPlanRequest,
	type DocxSemanticDiff,
	type DocxTouchedEntry,
	type DocxTouchedRun,
	type DocxTouchedXmlSlice,
	type DocxTransactionPlan,
	planDocxOperations,
	type ReplaceTextRunOperation,
	validateDocumentOperationEnvelope,
} from "./docx-operations.ts";
export { OfficeEngineError, type OfficeEngineErrorCode, officeError } from "./errors.ts";
