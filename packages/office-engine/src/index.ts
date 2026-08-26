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
export { OfficeEngineError, type OfficeEngineErrorCode, officeError } from "./errors.ts";
