import { XMLParser, XMLValidator } from "fast-xml-parser";
import { normalizeOpcPath, type PackageArchive } from "./archive.ts";
import { OfficeEngineError, officeError } from "./errors.ts";

export const CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types";
export const TRANSITIONAL_PACKAGE_RELATIONSHIPS_NAMESPACE =
	"http://schemas.openxmlformats.org/package/2006/relationships";
const STRICT_PACKAGE_RELATIONSHIPS_NAMESPACE = "http://purl.oclc.org/ooxml/package/relationships";
export const TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP =
	"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
export const STRICT_OFFICE_DOCUMENT_RELATIONSHIP =
	"http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument";
export const WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE =
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

export interface DocxMainPart {
	readonly path: string;
	readonly contentType: typeof WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE;
}

export interface DocxPartWarning {
	readonly code:
		| "UNSUPPORTED_HEADER"
		| "UNSUPPORTED_FOOTER"
		| "UNSUPPORTED_FOOTNOTE"
		| "UNSUPPORTED_ENDNOTE"
		| "UNSUPPORTED_COMMENTS"
		| "UNSUPPORTED_DRAWING"
		| "UNSUPPORTED_PART";
	readonly part: string;
	readonly message: string;
}

export interface DocxPackageResolution {
	readonly mainPart: DocxMainPart;
	readonly warnings: readonly DocxPartWarning[];
}

type XmlRecord = Record<string, unknown>;
type NamespaceBindings = Map<string, string>;

interface XmlElement {
	readonly record: XmlRecord;
	readonly bindings: NamespaceBindings;
	readonly namespace: string;
}

const XML_LIMIT = 16 * 1024 * 1024;
const XML_DECODER = new TextDecoder("utf-8", { fatal: true });
const PREDEFINED_ENTITY_VALUES: Readonly<Record<string, string>> = Object.freeze({
	amp: "&",
	quot: '"',
	lt: "<",
	gt: ">",
	apos: "'",
});
const PREDEFINED_ENTITIES = new Set(Object.keys(PREDEFINED_ENTITY_VALUES));
const XML_ENTITY = /^&(#(?:[xX][0-9a-fA-F]+|[0-9]+)|[A-Za-z_][A-Za-z0-9_.:-]*);/;
const XML_ENTITY_GLOBAL = /&(#(?:[xX][0-9a-fA-F]+|[0-9]+)|[A-Za-z_][A-Za-z0-9_.:-]*);/g;
const XML_PARSER = new XMLParser({
	ignoreAttributes: false,
	ignoreDeclaration: true,
	attributeNamePrefix: "@_",
	processEntities: false,
	parseTagValue: false,
	parseAttributeValue: false,
	maxNestedTags: 100,
});
const DIGITAL_SIGNATURE_RELATIONSHIP_TYPES = new Set([
	"http://schemas.openxmlformats.org/package/2006/relationships/digital-signature/origin",
	"http://schemas.openxmlformats.org/package/2006/relationships/digital-signature/signature",
	"http://purl.oclc.org/ooxml/package/relationships/digital-signature/origin",
	"http://purl.oclc.org/ooxml/package/relationships/digital-signature/signature",
]);
const DIGITAL_SIGNATURE_CONTENT_TYPES = new Set([
	"application/vnd.openxmlformats-package.digital-signature-origin",
	"application/vnd.openxmlformats-package.digital-signature-xmlsignature+xml",
]);

function isDigitalSignatureType(value: string, types: ReadonlySet<string>): boolean {
	return types.has(value.toLowerCase());
}

function asRecord(value: unknown): XmlRecord | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as XmlRecord;
}

function isXmlCharacter(value: number): boolean {
	return (
		value === 0x9 ||
		value === 0xa ||
		value === 0xd ||
		(value >= 0x20 && value <= 0xd7ff) ||
		(value >= 0xe000 && value <= 0xfffd) ||
		(value >= 0x10000 && value <= 0x10ffff)
	);
}

function isAllowedEntityReference(reference: string): boolean {
	if (PREDEFINED_ENTITIES.has(reference)) return true;
	if (reference.startsWith("#x") || reference.startsWith("#X")) {
		const codePoint = Number.parseInt(reference.slice(2), 16);
		return Number.isSafeInteger(codePoint) && isXmlCharacter(codePoint);
	}
	if (reference.startsWith("#")) {
		const codePoint = Number.parseInt(reference.slice(1), 10);
		return Number.isSafeInteger(codePoint) && isXmlCharacter(codePoint);
	}
	return false;
}

function validateEntityReference(reference: string): void {
	if (!isAllowedEntityReference(reference)) throw officeError("XML_ENTITY_FORBIDDEN");
}

function validateXmlLexicalSafety(xml: string): void {
	let index = 0;
	while (index < xml.length) {
		if (xml.startsWith("<!--", index)) {
			const end = xml.indexOf("-->", index + 4);
			if (end < 0) throw officeError("XML_INVALID");
			index = end + 3;
			continue;
		}
		if (xml.startsWith("<![CDATA[", index)) {
			const end = xml.indexOf("]]>", index + 9);
			if (end < 0) throw officeError("XML_INVALID");
			index = end + 3;
			continue;
		}
		if (xml.startsWith("<?", index)) {
			const end = xml.indexOf("?>", index + 2);
			if (end < 0) throw officeError("XML_INVALID");
			if (!/^xml(?=[\s?])/i.test(xml.slice(index + 2, end))) {
				throw officeError("XML_PI_FORBIDDEN");
			}
			index = end + 2;
			continue;
		}
		if (xml[index] === "<") {
			const markup = xml.slice(index);
			if (/^<!\s*DOCTYPE\b/i.test(markup)) throw officeError("XML_DTD_FORBIDDEN");
			if (/^<!\s*ENTITY\b/i.test(markup)) throw officeError("XML_ENTITY_FORBIDDEN");
			index += 1;
			continue;
		}
		if (xml[index] === "&") {
			const match = xml.slice(index).match(XML_ENTITY);
			if (match !== null) {
				validateEntityReference(match[1]);
				index += match[0].length;
				continue;
			}
		}
		index += 1;
	}
}

function decodeEntityReferences(value: string): string {
	return value.replace(XML_ENTITY_GLOBAL, (match, reference: string) => {
		if (PREDEFINED_ENTITIES.has(reference)) return PREDEFINED_ENTITY_VALUES[reference];
		if (!isAllowedEntityReference(reference)) return match;
		const codePoint =
			reference.startsWith("#x") || reference.startsWith("#X")
				? Number.parseInt(reference.slice(2), 16)
				: Number.parseInt(reference.slice(1), 10);
		return String.fromCodePoint(codePoint);
	});
}

function decodeParsedValue(value: unknown): unknown {
	if (typeof value === "string") return decodeEntityReferences(value);
	if (Array.isArray(value)) return value.map(decodeParsedValue);
	const record = asRecord(value);
	if (record === undefined) return value;
	const decoded: XmlRecord = {};
	for (const [key, item] of Object.entries(record)) decoded[key] = decodeParsedValue(item);
	return decoded;
}

function parseXml(bytes: Uint8Array): XmlRecord {
	if (bytes.byteLength > XML_LIMIT) throw officeError("XML_TOO_LARGE");
	let xml: string;
	try {
		xml = XML_DECODER.decode(bytes);
	} catch {
		throw officeError("XML_INVALID");
	}
	validateXmlLexicalSafety(xml);
	if (XMLValidator.validate(xml, { allowBooleanAttributes: false }) !== true) throw officeError("XML_INVALID");
	try {
		const parsed: unknown = XML_PARSER.parse(xml);
		const record = asRecord(decodeParsedValue(parsed));
		if (record === undefined) throw officeError("XML_INVALID");
		return record;
	} catch (error) {
		if (error instanceof OfficeEngineError) throw error;
		throw officeError("XML_INVALID");
	}
}

function readXml(archive: PackageArchive, path: string): XmlRecord {
	try {
		const entry = archive.entries().find((item) => item.path === path);
		if (entry !== undefined && entry.uncompressedSize > XML_LIMIT) throw officeError("XML_TOO_LARGE");
		return parseXml(archive.read(path));
	} catch (error) {
		if (error instanceof OfficeEngineError) throw error;
		throw officeError("XML_INVALID");
	}
}

function namespaceBindings(record: XmlRecord, inherited: ReadonlyMap<string, string>): NamespaceBindings {
	const bindings = new Map(inherited);
	for (const [key, value] of Object.entries(record)) {
		if (typeof value !== "string") continue;
		if (key === "@_xmlns") bindings.set("", value);
		else if (key.startsWith("@_xmlns:")) bindings.set(key.slice("@_xmlns:".length), value);
	}
	return bindings;
}

function qNameParts(qName: string): {
	readonly local: string;
	readonly prefix: string;
} {
	const separator = qName.indexOf(":");
	return separator < 0
		? { local: qName, prefix: "" }
		: { local: qName.slice(separator + 1), prefix: qName.slice(0, separator) };
}

function elementNamespace(qName: string, bindings: ReadonlyMap<string, string>): string | undefined {
	return bindings.get(qNameParts(qName).prefix);
}

function rootElement(
	parsed: XmlRecord,
	local: string,
	supportedNamespaces: ReadonlySet<string>,
	code: "DOCX_CONTENT_TYPE_INVALID" | "DOCX_RELATIONSHIP_INVALID",
): XmlElement {
	const roots = Object.entries(parsed).filter(([key]) => !key.startsWith("@_"));
	if (roots.length !== 1) throw officeError(code);
	const [qName, value] = roots[0];
	const record = asRecord(value);
	if (record === undefined) throw officeError(code);
	const bindings = namespaceBindings(record, new Map());
	const namespace = elementNamespace(qName, bindings);
	if (qNameParts(qName).local !== local || namespace === undefined || !supportedNamespaces.has(namespace)) {
		throw officeError(code);
	}
	return { record, bindings, namespace };
}

function childElements(
	parent: XmlElement,
	local: string,
	code: "DOCX_CONTENT_TYPE_INVALID" | "DOCX_RELATIONSHIP_INVALID",
): XmlElement[] {
	const result: XmlElement[] = [];
	for (const [qName, value] of Object.entries(parent.record)) {
		if (qName.startsWith("@_") || qNameParts(qName).local !== local) continue;
		const values = Array.isArray(value) ? value : [value];
		for (const item of values) {
			const record = asRecord(item);
			if (record === undefined) throw officeError(code);
			const bindings = namespaceBindings(record, parent.bindings);
			const namespace = elementNamespace(qName, bindings);
			if (namespace !== parent.namespace) throw officeError(code);
			result.push({ record, bindings, namespace });
		}
	}
	return result;
}

function validateElementSchema(
	element: XmlElement,
	allowedChildren: ReadonlySet<string>,
	allowedAttributes: ReadonlySet<string>,
	code: "DOCX_CONTENT_TYPE_INVALID" | "DOCX_RELATIONSHIP_INVALID",
): void {
	for (const [qName, value] of Object.entries(element.record)) {
		if (qName.startsWith("@_")) {
			const attributeName = qName.slice(2);
			const namespaceDeclaration =
				(attributeName === "xmlns" || attributeName.startsWith("xmlns:")) && value === element.namespace;
			if (!namespaceDeclaration && !allowedAttributes.has(attributeName)) throw officeError(code);
			continue;
		}
		if (!allowedChildren.has(qNameParts(qName).local)) throw officeError(code);
		const bindings = namespaceBindings(asRecord(Array.isArray(value) ? value[0] : value) ?? {}, element.bindings);
		if (elementNamespace(qName, bindings) !== element.namespace) throw officeError(code);
	}
}

function attribute(record: XmlRecord, name: string): string | undefined {
	const value = record[`@_${name}`];
	return typeof value === "string" ? value : undefined;
}

function requiredAttribute(
	record: XmlRecord,
	name: string,
	code: "DOCX_CONTENT_TYPE_INVALID" | "DOCX_RELATIONSHIP_INVALID",
): string {
	const value = attribute(record, name);
	if (value === undefined || value.length === 0) throw officeError(code);
	return value;
}

function isNcName(value: string): boolean {
	if (value.length === 0) return false;
	let first = true;
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint === undefined) return false;
		const isStart =
			codePoint === 0x5f ||
			(codePoint >= 0x41 && codePoint <= 0x5a) ||
			(codePoint >= 0x61 && codePoint <= 0x7a) ||
			(codePoint >= 0xc0 && codePoint <= 0x2ff) ||
			(codePoint >= 0x370 && codePoint <= 0x37d) ||
			(codePoint >= 0x37f && codePoint <= 0x1fff) ||
			(codePoint >= 0x200c && codePoint <= 0x200d) ||
			(codePoint >= 0x2070 && codePoint <= 0x218f) ||
			(codePoint >= 0x2c00 && codePoint <= 0x2fef) ||
			(codePoint >= 0x3001 && codePoint <= 0xd7ff) ||
			(codePoint >= 0xf900 && codePoint <= 0xfdcf) ||
			(codePoint >= 0xfdf0 && codePoint <= 0xfffd) ||
			(codePoint >= 0x10000 && codePoint <= 0xeffff);
		const isExtra =
			(codePoint >= 0x30 && codePoint <= 0x39) ||
			codePoint === 0x2d ||
			codePoint === 0x2e ||
			codePoint === 0xb7 ||
			(codePoint >= 0x300 && codePoint <= 0x36f) ||
			(codePoint >= 0x203f && codePoint <= 0x2040);
		if (first ? !isStart : !isStart && !isExtra) return false;
		first = false;
	}
	return true;
}

function resolvePartName(partName: string): string {
	if (!partName.startsWith("/") || partName.length === 1) throw officeError("DOCX_CONTENT_TYPE_INVALID");
	try {
		return normalizeOpcPath(partName.slice(1));
	} catch {
		throw officeError("DOCX_CONTENT_TYPE_INVALID");
	}
}

function rejectEncodedPathSyntax(target: string): void {
	for (const match of target.matchAll(/%([0-9a-f]{2})/gi)) {
		const codePoint = Number.parseInt(match[1], 16);
		if (
			codePoint === 0x2f ||
			codePoint === 0x5c ||
			codePoint === 0x2e ||
			codePoint === 0x3f ||
			codePoint === 0x23 ||
			codePoint === 0x00
		) {
			throw officeError("DOCX_TARGET_INVALID");
		}
	}
}

function resolveRelationshipTarget(target: string, sourcePart?: string): string {
	if (target.length === 0 || target.includes("\\") || target.includes("\u0000"))
		throw officeError("DOCX_TARGET_INVALID");
	rejectEncodedPathSyntax(target);
	let decoded: string;
	try {
		decoded = decodeURIComponent(target);
	} catch {
		throw officeError("DOCX_TARGET_INVALID");
	}
	if (
		decoded.length === 0 ||
		decoded.startsWith("//") ||
		decoded.includes("\\") ||
		decoded.includes("\u0000") ||
		decoded.includes("?") ||
		decoded.includes("#") ||
		/^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded) ||
		/[\u2044\u2215\u2216\u2217\u29f8\uff0f\uff3c\u2024\u2025]/u.test(decoded)
	) {
		throw officeError("DOCX_TARGET_INVALID");
	}
	if (sourcePart === undefined && decoded.startsWith("/")) {
		decoded = decoded.slice(1);
	} else if (sourcePart !== undefined && decoded.startsWith("/")) {
		throw officeError("DOCX_TARGET_INVALID");
	}
	const decodedSegments = decoded.split("/");
	if (
		decodedSegments.some((segment) => segment.length === 0 || segment === ".") ||
		(sourcePart === undefined && decodedSegments.includes(".."))
	)
		throw officeError("DOCX_TARGET_INVALID");
	const base =
		sourcePart === undefined
			? []
			: sourcePart
					.slice(0, sourcePart.lastIndexOf("/") + 1)
					.split("/")
					.filter(Boolean);
	const segments = [...base, ...decodedSegments];
	const resolved: string[] = [];
	for (const segment of segments) {
		if (segment.length === 0 || segment === ".") continue;
		if (segment === "..") {
			if (resolved.length === 0) throw officeError("DOCX_TARGET_INVALID");
			resolved.pop();
			continue;
		}
		resolved.push(segment);
	}
	if (resolved.length === 0) throw officeError("DOCX_TARGET_INVALID");
	try {
		return normalizeOpcPath(resolved.join("/"));
	} catch {
		throw officeError("DOCX_TARGET_INVALID");
	}
}

const RELATIONSHIP_ATTRIBUTES = new Set(["Id", "Type", "Target", "TargetMode"]);

interface ParsedRelationship {
	readonly id: string;
	readonly type: string;
	readonly target: string;
	readonly targetMode: string | undefined;
}

function parseRelationships(root: XmlElement): ParsedRelationship[] {
	validateElementSchema(root, new Set(["Relationship"]), new Set(), "DOCX_RELATIONSHIP_INVALID");
	const ids = new Set<string>();
	return childElements(root, "Relationship", "DOCX_RELATIONSHIP_INVALID").map((relationship) => {
		validateElementSchema(relationship, new Set(), RELATIONSHIP_ATTRIBUTES, "DOCX_RELATIONSHIP_INVALID");
		const id = requiredAttribute(relationship.record, "Id", "DOCX_RELATIONSHIP_INVALID");
		if (!isNcName(id) || ids.has(id)) throw officeError("DOCX_RELATIONSHIP_INVALID");
		ids.add(id);
		const type = requiredAttribute(relationship.record, "Type", "DOCX_RELATIONSHIP_INVALID");
		const target = requiredAttribute(relationship.record, "Target", "DOCX_RELATIONSHIP_INVALID");
		const targetMode = attribute(relationship.record, "TargetMode");
		if (targetMode !== undefined && targetMode !== "Internal" && targetMode !== "External")
			throw officeError("DOCX_RELATIONSHIP_INVALID");
		if (isDigitalSignatureType(type, DIGITAL_SIGNATURE_RELATIONSHIP_TYPES)) throw officeError("ARCHIVE_INVALID");
		return { id, type, target, targetMode };
	});
}

function relationshipPartSource(path: string): string {
	if (!path.endsWith(".rels") || path === "_rels/.rels") throw officeError("DOCX_RELATIONSHIP_INVALID");
	const marker = "/_rels/";
	const markerIndex = path.indexOf(marker);
	if (markerIndex < 0 || !path.endsWith(".rels") || path.slice(markerIndex + marker.length).includes("/_rels/"))
		throw officeError("DOCX_RELATIONSHIP_INVALID");
	const source = `${path.slice(0, markerIndex)}/${path.slice(markerIndex + marker.length, -5)}`;
	if (source.endsWith("/")) throw officeError("DOCX_RELATIONSHIP_INVALID");
	return source;
}

function extensionOf(path: string): string | undefined {
	const slash = path.lastIndexOf("/");
	const dot = path.lastIndexOf(".");
	if (dot <= slash || dot === path.length - 1) return undefined;
	return path.slice(dot + 1).toLowerCase();
}

const RELATIONSHIP_WARNING_CODES: ReadonlyMap<string, DocxPartWarning["code"]> = new Map(
	(
		[
			["header", "UNSUPPORTED_HEADER"],
			["footer", "UNSUPPORTED_FOOTER"],
			["footnotes", "UNSUPPORTED_FOOTNOTE"],
			["endnotes", "UNSUPPORTED_ENDNOTE"],
			["comments", "UNSUPPORTED_COMMENTS"],
			["image", "UNSUPPORTED_DRAWING"],
			["drawing", "UNSUPPORTED_DRAWING"],
			["oleObject", "UNSUPPORTED_PART"],
			["object", "UNSUPPORTED_PART"],
		] as ReadonlyArray<readonly [string, DocxPartWarning["code"]]>
	).flatMap(([local, code]) => [
		[`http://schemas.openxmlformats.org/officeDocument/2006/relationships/${local}`, code],
		[`http://purl.oclc.org/ooxml/officeDocument/relationships/${local}`, code],
	]),
);

function warningCodeForRelationship(type: string): DocxPartWarning["code"] | undefined {
	return RELATIONSHIP_WARNING_CODES.get(type);
}

function contentTypeFor(
	overrides: ReadonlyMap<string, string>,
	defaults: ReadonlyMap<string, string>,
	path: string,
): string | undefined {
	return (
		overrides.get(path) ?? (extensionOf(path) === undefined ? undefined : defaults.get(extensionOf(path) as string))
	);
}

export function resolveDocx(archive: PackageArchive): DocxPackageResolution {
	const entries = new Set(archive.entries().map((entry) => entry.path));
	const contentTypes = (() => {
		try {
			return readXml(archive, "[Content_Types].xml");
		} catch (error) {
			if (error instanceof OfficeEngineError && error.code === "ARCHIVE_INVALID")
				throw officeError("DOCX_MISSING_CONTENT_TYPES");
			throw error;
		}
	})();
	const typesRoot = rootElement(
		contentTypes,
		"Types",
		new Set([CONTENT_TYPES_NAMESPACE]),
		"DOCX_CONTENT_TYPE_INVALID",
	);
	validateElementSchema(typesRoot, new Set(["Default", "Override"]), new Set(), "DOCX_CONTENT_TYPE_INVALID");
	const overrides = new Map<string, string>();
	const defaults = new Map<string, string>();
	for (const override of childElements(typesRoot, "Override", "DOCX_CONTENT_TYPE_INVALID")) {
		validateElementSchema(override, new Set(), new Set(["PartName", "ContentType"]), "DOCX_CONTENT_TYPE_INVALID");
		const part = resolvePartName(requiredAttribute(override.record, "PartName", "DOCX_CONTENT_TYPE_INVALID"));
		const type = requiredAttribute(override.record, "ContentType", "DOCX_CONTENT_TYPE_INVALID");
		if (overrides.has(part)) throw officeError("DOCX_CONTENT_TYPE_INVALID");
		if (isDigitalSignatureType(type, DIGITAL_SIGNATURE_CONTENT_TYPES)) throw officeError("ARCHIVE_INVALID");
		overrides.set(part, type);
	}
	for (const defaultType of childElements(typesRoot, "Default", "DOCX_CONTENT_TYPE_INVALID")) {
		validateElementSchema(defaultType, new Set(), new Set(["Extension", "ContentType"]), "DOCX_CONTENT_TYPE_INVALID");
		const extension = requiredAttribute(defaultType.record, "Extension", "DOCX_CONTENT_TYPE_INVALID").toLowerCase();
		const type = requiredAttribute(defaultType.record, "ContentType", "DOCX_CONTENT_TYPE_INVALID");
		if (extension.includes("/") || extension.includes("\\") || extension.includes(".") || defaults.has(extension))
			throw officeError("DOCX_CONTENT_TYPE_INVALID");
		if (isDigitalSignatureType(type, DIGITAL_SIGNATURE_CONTENT_TYPES)) throw officeError("ARCHIVE_INVALID");
		defaults.set(extension, type);
	}
	const warnings = new Map<string, DocxPartWarning>();
	const inspectRelationships = (relationshipPath: string, sourcePart: string | undefined): ParsedRelationship[] => {
		const root = rootElement(
			readXml(archive, relationshipPath),
			"Relationships",
			new Set([TRANSITIONAL_PACKAGE_RELATIONSHIPS_NAMESPACE, STRICT_PACKAGE_RELATIONSHIPS_NAMESPACE]),
			"DOCX_RELATIONSHIP_INVALID",
		);
		const relationships = parseRelationships(root);
		for (const relationship of relationships) {
			const isOfficeDocument =
				relationship.type === TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP ||
				relationship.type === STRICT_OFFICE_DOCUMENT_RELATIONSHIP;
			if (relationship.targetMode === "External") {
				if (sourcePart === undefined && isOfficeDocument) throw officeError("DOCX_EXTERNAL_RELATIONSHIP");
				continue;
			}
			const target = resolveRelationshipTarget(relationship.target, sourcePart);
			if (!entries.has(target)) {
				if (sourcePart === undefined && isOfficeDocument) continue;
				throw officeError("DOCX_TARGET_INVALID");
			}
			const code = warningCodeForRelationship(relationship.type);
			if (code !== undefined && target !== sourcePart)
				warnings.set(`${code}:${target}`, {
					code,
					part: target,
					message: `${target} is outside editable main document scope`,
				});
		}
		return relationships;
	};
	for (const entry of archive.entries()) {
		if (!entry.path.toLowerCase().endsWith(".rels") || entry.path === "_rels/.rels") continue;
		const source = relationshipPartSource(entry.path);
		if (!entries.has(source)) throw officeError("DOCX_RELATIONSHIP_INVALID");
		inspectRelationships(entry.path, source);
	}
	let rootRelationships: ParsedRelationship[];
	try {
		rootRelationships = inspectRelationships("_rels/.rels", undefined);
	} catch (error) {
		if (error instanceof OfficeEngineError && error.code === "ARCHIVE_INVALID")
			throw officeError("DOCX_MISSING_ROOT_RELATIONSHIPS");
		throw error;
	}
	const candidates = rootRelationships.filter(
		(relationship) =>
			relationship.type === TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP ||
			relationship.type === STRICT_OFFICE_DOCUMENT_RELATIONSHIP,
	);
	if (candidates.length === 0) throw officeError("DOCX_MISSING_OFFICE_DOCUMENT");
	if (candidates.length > 1) throw officeError("DOCX_DUPLICATE_OFFICE_DOCUMENT");
	const mainPart = resolveRelationshipTarget(candidates[0].target);
	if (!entries.has(mainPart)) throw officeError("DOCX_MAIN_PART_MISSING");
	if (contentTypeFor(overrides, defaults, mainPart)?.toLowerCase() !== WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE)
		throw officeError("DOCX_MAIN_CONTENT_TYPE_INVALID");
	warnings.delete(`UNSUPPORTED_PART:${mainPart}`);
	return {
		mainPart: {
			path: mainPart,
			contentType: WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE,
		},
		warnings: [...warnings.values()].sort(
			(left, right) => left.part.localeCompare(right.part) || left.code.localeCompare(right.code),
		),
	};
}

export const resolveDocxMainPart = resolveDocx;
