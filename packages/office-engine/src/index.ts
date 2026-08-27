export {
	type ArchiveLimits,
	DEFAULT_ARCHIVE_LIMITS,
	normalizeOpcPath,
	PackageArchive,
	type PackageArchiveEntry,
	verifyReplacement,
} from "./archive.ts";
export {
	CONTENT_TYPES_NAMESPACE,
	type DocxMainPart,
	type DocxPackageResolution,
	type DocxPartWarning,
	resolveDocx,
	resolveDocxMainPart,
	STRICT_OFFICE_DOCUMENT_RELATIONSHIP,
	TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP,
	TRANSITIONAL_PACKAGE_RELATIONSHIPS_NAMESPACE,
	WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE,
} from "./docx.ts";
export { OfficeEngineError, type OfficeEngineErrorCode, officeError } from "./errors.ts";
export {
	commitDocx,
	type DocumentOperation,
	type DocumentOperationEnvelope,
	type DocumentPlan,
	type DocxBlockedReason,
	type DocxInspectSnapshot,
	type DocxParagraphSnapshot,
	type DocxTextRunSnapshot,
	inspectDocx,
	planDocx,
	type ReplaceTextRunOperation,
	sha256Hex,
	TRANSACTION_BUDGETS,
	validateDocumentOperationEnvelope,
} from "./transaction.ts";
