import { sha256 } from "@noble/hashes/sha2.js";
import { XMLParser } from "fast-xml-parser";
import type { SaxesTag } from "saxes";
import { SaxesParser } from "saxes";
import { PackageArchive, resolveOpcRelationshipTarget } from "./archive.ts";
import { officeError } from "./errors.ts";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "@_",
	removeNSPrefix: true,
	processEntities: false,
	trimValues: false,
});
const OFFICE_TYPES = new Set([
	"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
	"http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument",
]);
const WORKSHEET_TYPES = new Set([
	"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",
	"http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet",
]);
const SHARED_STRING_TYPES = new Set([
	"http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings",
	"http://purl.oclc.org/ooxml/officeDocument/relationships/sharedStrings",
]);
const WORKSHEET_NAMESPACES = new Set([
	"http://schemas.openxmlformats.org/spreadsheetml/2006/main",
	"http://purl.oclc.org/ooxml/spreadsheetml/main",
]);
const PACKAGE_RELATIONSHIP_NAMESPACES = new Set([
	"http://schemas.openxmlformats.org/package/2006/relationships",
	"http://purl.oclc.org/ooxml/package/relationships",
]);
const CONTENT_TYPE_NAMESPACES = new Set(["http://schemas.openxmlformats.org/package/2006/content-types"]);
const MAX_XML_BYTES = 16 * 1024 * 1024;
const MAX_CELLS = 200_000;
const MAX_SHEETS = 100;
const MAX_XML_NODES = 200_000;
const MAX_XML_DEPTH = 256;
const MAX_OPERATIONS = 100;
const MAX_XLSX_ROW = 1_048_576;
const MAX_XLSX_COLUMN = 16_384;
const WORKBOOK_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
const WORKSHEET_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
const SHARED_STRINGS_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml";
const MODELED_CELL_ELEMENTS = new Set(["f", "v", "is", "t"]);
const MODELED_CELL_ATTRIBUTES = new Set(["r", "s", "t"]);

interface Relationship {
	readonly Id: string;
	readonly Type: string;
	readonly Target: string;
	readonly TargetMode?: string;
}

export interface XlsxCellSnapshot {
	readonly id: string;
	readonly address: string;
	readonly value: string;
	readonly valueSha256: string;
	readonly valueType: "string" | "number" | "boolean" | "error" | "blank";
	readonly editable: boolean;
	readonly blockedReason?: "formula" | "unsupported-cell";
	readonly anchor: { readonly part: string; readonly start: number; readonly end: number };
	readonly styleId?: string;
}

export interface XlsxSheetSnapshot {
	readonly id: string;
	readonly relationshipId: string;
	readonly name: string;
	readonly part: string;
	readonly cells: readonly XlsxCellSnapshot[];
}

export interface XlsxInspectSnapshot {
	readonly documentId: string;
	readonly revision: number;
	readonly workbookPart: string;
	readonly sheets: readonly XlsxSheetSnapshot[];
	readonly sourceSha256: string;
}

export interface SetCellValueOperation {
	readonly type: "set_cell_value";
	readonly target: { readonly sheetId: string; readonly cellId: string; readonly address: string };
	readonly precondition: {
		readonly documentRevision: number;
		readonly expectedValue: string;
		readonly expectedValueSha256: string;
	};
	readonly replacement: string;
}

export interface XlsxOperationEnvelope {
	readonly protocolVersion: 1;
	readonly operations: readonly SetCellValueOperation[];
}

export interface XlsxSemanticDiff {
	readonly type: "cell-value";
	readonly sheetId: string;
	readonly cellId: string;
	readonly address: string;
	readonly before: string;
	readonly after: string;
}

export interface XlsxPlan {
	readonly planId: string;
	readonly documentId: string;
	readonly baseRevision: number;
	readonly resultingRevision: number;
	readonly operations: readonly SetCellValueOperation[];
	readonly semanticDiff: readonly XlsxSemanticDiff[];
	readonly touchedCells: readonly string[];
	readonly touchedParts: readonly string[];
	readonly expiresAt: number;
	readonly sourceSha256: string;
	readonly planSha256: string;
}

interface ContentTypes {
	readonly defaults: ReadonlyMap<string, string>;
	readonly overrides: ReadonlyMap<string, string>;
}

interface WorksheetElement {
	readonly local: string;
	readonly namespace: string;
	readonly row?: number;
}

interface CellBuilder {
	address: string;
	start: number;
	end: number;
	styleId?: string;
	cellType?: string;
	hasFormula: boolean;
	value: string;
	inlineText: string;
	currentText: "value" | "inline" | undefined;
	unsupportedStructure: boolean;
}

export function inspectXlsx(archive: PackageArchive, documentId: string, revision = 1): XlsxInspectSnapshot {
	const rootRelationships = relationships(archive, "_rels/.rels");
	const office = rootRelationships.filter((item) => OFFICE_TYPES.has(item.Type));
	if (office.length !== 1 || office[0]?.TargetMode?.toLowerCase() === "external")
		throw officeError("VALIDATION_FAILED");
	const workbookPart = resolveTarget("", office[0].Target);
	const contentTypes = parseContentTypes(archive.read("[Content_Types].xml"));
	if (contentTypeForPart(contentTypes, workbookPart) !== WORKBOOK_CONTENT_TYPE) {
		throw officeError("VALIDATION_FAILED");
	}
	const workbook = parseXml(archive.read(workbookPart), {
		root: "workbook",
		namespaces: WORKSHEET_NAMESPACES,
		semanticElements: new Set(["workbook", "sheets", "sheet"]),
	});
	const workbookRelationships = relationships(archive, relationshipPart(workbookPart));
	const byId = new Map<string, Relationship>();
	for (const relationship of workbookRelationships) {
		if (byId.has(relationship.Id)) throw officeError("VALIDATION_FAILED");
		byId.set(relationship.Id, relationship);
	}
	const sharedRelationships = workbookRelationships.filter((item) => SHARED_STRING_TYPES.has(item.Type));
	if (sharedRelationships.length > 1) throw officeError("VALIDATION_FAILED");
	const shared = sharedRelationships[0];
	if (shared?.TargetMode?.toLowerCase() === "external") throw officeError("VALIDATION_FAILED");
	const sharedPart = shared ? resolveTarget(workbookPart, shared.Target) : undefined;
	if (sharedPart && contentTypeForPart(contentTypes, sharedPart) !== SHARED_STRINGS_CONTENT_TYPE) {
		throw officeError("VALIDATION_FAILED");
	}
	const sharedStrings = sharedPart ? parseSharedStrings(archive.read(sharedPart)) : [];
	const sheetNodes = recordArray(child(childRecord(childRecord(workbook, "workbook"), "sheets"), "sheet"));
	if (sheetNodes.length === 0 || sheetNodes.length > MAX_SHEETS) throw officeError("VALIDATION_FAILED");
	const sheetIds = new Set<string>();
	let totalCells = 0;
	const sheets = sheetNodes.map((node: Record<string, unknown>) => {
		const relationshipId = stringAttr(node, "id");
		if (sheetIds.has(relationshipId)) throw officeError("VALIDATION_FAILED");
		sheetIds.add(relationshipId);
		const relationship = byId.get(relationshipId);
		if (
			!relationship ||
			!WORKSHEET_TYPES.has(relationship.Type) ||
			relationship.TargetMode?.toLowerCase() === "external"
		) {
			throw officeError("VALIDATION_FAILED");
		}
		const part = resolveTarget(workbookPart, relationship.Target);
		if (contentTypeForPart(contentTypes, part) !== WORKSHEET_CONTENT_TYPE) {
			throw officeError("VALIDATION_FAILED");
		}
		const sheet = inspectWorksheet(archive.read(part), {
			id: `sheet:${relationshipId}`,
			relationshipId,
			name: stringAttr(node, "name"),
			part,
			sharedStrings,
		});
		totalCells += sheet.cells.length;
		if (totalCells > MAX_CELLS) throw officeError("XML_INVALID");
		return sheet;
	});
	return {
		documentId,
		revision,
		workbookPart,
		sheets,
		sourceSha256: hex(sha256(archive.serialize())),
	};
}

export function validateXlsxOperationEnvelope(value: unknown): XlsxOperationEnvelope {
	const envelope = record(value);
	exactKeys(envelope, ["protocolVersion", "operations"]);
	if (
		envelope.protocolVersion !== 1 ||
		!Array.isArray(envelope.operations) ||
		envelope.operations.length === 0 ||
		envelope.operations.length > MAX_OPERATIONS
	) {
		throw officeError("VALIDATION_FAILED");
	}
	const operations = envelope.operations.map((raw) => {
		const operation = record(raw);
		exactKeys(operation, ["type", "target", "precondition", "replacement"]);
		if (operation.type !== "set_cell_value" || typeof operation.replacement !== "string")
			throw officeError("VALIDATION_FAILED");
		const target = record(operation.target);
		exactKeys(target, ["sheetId", "cellId", "address"]);
		const precondition = record(operation.precondition);
		exactKeys(precondition, ["documentRevision", "expectedValue", "expectedValueSha256"]);
		const sheetId = boundedString(target.sheetId);
		const cellId = boundedString(target.cellId);
		const address = boundedString(target.address).toUpperCase();
		if (!validCellAddress(address)) throw officeError("VALIDATION_FAILED");
		const expectedValue = boundedString(precondition.expectedValue, 100_000);
		const replacement = boundedString(operation.replacement, 100_000, true);
		if (!validXmlText(expectedValue) || !validXmlText(replacement)) throw officeError("VALIDATION_FAILED");
		const expectedValueSha256 = boundedString(precondition.expectedValueSha256);
		if (!Number.isSafeInteger(precondition.documentRevision) || expectedValueSha256 !== hashText(expectedValue)) {
			throw officeError("VALIDATION_FAILED");
		}
		return {
			type: "set_cell_value" as const,
			target: { sheetId, cellId, address },
			precondition: {
				documentRevision: precondition.documentRevision as number,
				expectedValue,
				expectedValueSha256,
			},
			replacement,
		};
	});
	return { protocolVersion: 1, operations };
}

export function planXlsx(
	archive: PackageArchive,
	snapshot: XlsxInspectSnapshot,
	input: unknown,
	expiresAt: number,
	now = Date.now(),
): XlsxPlan {
	if (expiresAt <= now) throw officeError("TRANSACTION_EXPIRED");
	const envelope = validateXlsxOperationEnvelope(input);
	const current = inspectXlsx(archive, snapshot.documentId, snapshot.revision);
	if (current.sourceSha256 !== snapshot.sourceSha256) throw officeError("STALE_DOCUMENT");
	const sheets = new Map(current.sheets.map((sheet) => [sheet.id, sheet]));
	const diffs: XlsxSemanticDiff[] = [];
	const touched = new Set<string>();
	for (const operation of envelope.operations) {
		if (operation.precondition.documentRevision !== snapshot.revision) throw officeError("PRECONDITION_FAILED");
		const sheet = sheets.get(operation.target.sheetId);
		const cell = sheet?.cells.find((item) => item.id === operation.target.cellId);
		if (!sheet || !cell || cell.address !== operation.target.address) throw officeError("PRECONDITION_FAILED");
		if (!cell.editable) throw officeError("OPERATION_BLOCKED");
		if (
			cell.value !== operation.precondition.expectedValue ||
			cell.valueSha256 !== operation.precondition.expectedValueSha256
		) {
			throw officeError("PRECONDITION_FAILED");
		}
		if (touched.has(cell.id)) throw officeError("VALIDATION_FAILED");
		touched.add(cell.id);
		diffs.push({
			type: "cell-value",
			sheetId: sheet.id,
			cellId: cell.id,
			address: cell.address,
			before: cell.value,
			after: operation.replacement,
		});
	}
	const touchedParts = [
		...new Set(diffs.map((diff) => sheets.get(diff.sheetId)?.part).filter((part): part is string => Boolean(part))),
	].sort();
	if (touchedParts.length > 1) throw officeError("VALIDATION_FAILED");
	const base = {
		documentId: snapshot.documentId,
		baseRevision: snapshot.revision,
		resultingRevision: snapshot.revision + 1,
		operations: envelope.operations,
		semanticDiff: diffs,
		touchedCells: [...touched].sort(),
		touchedParts,
		expiresAt,
		sourceSha256: snapshot.sourceSha256,
	};
	return { planId: crypto.randomUUID(), ...base, planSha256: hashText(canonical(base)) };
}

export function commitXlsx(
	archive: PackageArchive,
	snapshot: XlsxInspectSnapshot,
	plan: XlsxPlan,
	now = Date.now(),
): Uint8Array {
	if (plan.expiresAt <= now) throw officeError("TRANSACTION_EXPIRED");
	if (plan.documentId !== snapshot.documentId || plan.baseRevision !== snapshot.revision)
		throw officeError("STALE_DOCUMENT");
	const canonicalPlan = planXlsx(
		archive,
		snapshot,
		{ protocolVersion: 1, operations: plan.operations },
		plan.expiresAt,
		now,
	);
	if (
		canonicalPlan.planSha256 !== plan.planSha256 ||
		canonical({ ...canonicalPlan, planId: plan.planId }) !== canonical(plan)
	) {
		throw officeError("VALIDATION_FAILED");
	}
	if (plan.touchedParts.length === 0) return archive.serialize();
	const part = plan.touchedParts[0];
	if (!part) throw officeError("VALIDATION_FAILED");
	const sheet = snapshot.sheets.find((item) => item.part === part);
	if (!sheet) throw officeError("VALIDATION_FAILED");
	const cells = new Map(sheet.cells.map((cell) => [cell.id, cell]));
	const patches = plan.semanticDiff
		.map((diff) => {
			const cell = cells.get(diff.cellId);
			if (!cell || cell.anchor.part !== part) throw officeError("VALIDATION_FAILED");
			const style = cell.styleId ? ` s="${escapeAttribute(cell.styleId)}"` : "";
			const space = /^\s|\s$/u.test(diff.after) ? ' xml:space="preserve"' : "";
			return {
				start: cell.anchor.start,
				end: cell.anchor.end,
				replacement: encoder.encode(
					`<c r="${cell.address}"${style} t="inlineStr"><is><t${space}>${escapeText(diff.after)}</t></is></c>`,
				),
			};
		})
		.sort((left, right) => left.start - right.start);
	for (let index = 1; index < patches.length; index++)
		if ((patches[index - 1]?.end ?? 0) > (patches[index]?.start ?? 0)) throw officeError("VALIDATION_FAILED");
	const source = archive.read(part);
	const chunks: Uint8Array[] = [];
	let cursor = 0;
	for (const patch of patches) {
		chunks.push(source.subarray(cursor, patch.start), patch.replacement);
		cursor = patch.end;
	}
	chunks.push(source.subarray(cursor));
	const output = archive.replace(part, concat(chunks));
	const reopened = inspectXlsx(PackageArchive.open(output), snapshot.documentId, snapshot.revision + 1);
	for (const diff of plan.semanticDiff) {
		const cell = reopened.sheets
			.find((item) => item.id === diff.sheetId)
			?.cells.find((item) => item.id === diff.cellId);
		if (!cell || cell.value !== diff.after) throw officeError("VALIDATION_FAILED");
	}
	return output;
}

function inspectWorksheet(
	bytes: Uint8Array,
	input: { id: string; relationshipId: string; name: string; part: string; sharedStrings: readonly string[] },
): XlsxSheetSnapshot {
	if (bytes.length > MAX_XML_BYTES) throw officeError("XML_TOO_LARGE");
	const xml = decode(bytes);
	const byteOffsets = offsets(xml);
	const cells: XlsxCellSnapshot[] = [];
	const addresses = new Set<string>();
	let pendingStart = 0;
	let current: CellBuilder | undefined;
	let depth = 0;
	let nodes = 0;
	let validRoot = false;
	const elements: WorksheetElement[] = [];
	const sax = new SaxesParser({ xmlns: true, position: true });
	sax.on("doctype", () => {
		throw officeError("XML_DTD_FORBIDDEN");
	});
	sax.on("processinginstruction", (item) => {
		if (item.target.toLowerCase() !== "xml") throw officeError("XML_PI_FORBIDDEN");
	});
	sax.on("opentagstart", () => {
		pendingStart = byteOffsets[tagStart(xml, sax.position)];
	});
	sax.on("opentag", (tag: SaxesTag) => {
		depth++;
		nodes++;
		if (depth > MAX_XML_DEPTH || nodes > MAX_XML_NODES) throw officeError("XML_INVALID");
		const namespace = typeof tag.uri === "string" ? tag.uri : "";
		if (depth === 1) {
			validRoot = tag.local === "worksheet" && WORKSHEET_NAMESPACES.has(namespace);
			if (!validRoot) throw officeError("XML_INVALID");
		}
		const parent = elements.at(-1);
		const grandparent = elements.at(-2);
		let row: number | undefined;
		if (tag.local === "row" && WORKSHEET_NAMESPACES.has(namespace)) {
			const rawRow = attribute(tag, "r");
			if (rawRow) {
				row = Number(rawRow);
				if (!Number.isSafeInteger(row) || row < 1 || row > MAX_XLSX_ROW) throw officeError("XML_INVALID");
			}
		}
		if (tag.local === "c" && WORKSHEET_NAMESPACES.has(namespace)) {
			if (
				current ||
				cells.length >= MAX_CELLS ||
				depth !== 4 ||
				parent?.local !== "row" ||
				!WORKSHEET_NAMESPACES.has(parent.namespace) ||
				grandparent?.local !== "sheetData" ||
				!WORKSHEET_NAMESPACES.has(grandparent.namespace)
			) {
				throw officeError("XML_INVALID");
			}
			const address = attribute(tag, "r").toUpperCase();
			const point = parseCellAddress(address);
			if (!point || addresses.has(address) || (parent.row !== undefined && parent.row !== point.row)) {
				throw officeError("XML_INVALID");
			}
			addresses.add(address);
			current = {
				address,
				start: pendingStart,
				end: 0,
				styleId: attribute(tag, "s") || undefined,
				cellType: attribute(tag, "t") || undefined,
				hasFormula: false,
				value: "",
				inlineText: "",
				currentText: undefined,
				unsupportedStructure: !modeledCellAttributes(tag),
			};
		} else if (current) {
			if (!isWorksheetTag(tag) || !MODELED_CELL_ELEMENTS.has(tag.local ?? "")) current.unsupportedStructure = true;
			if (tag.local === "f" && isWorksheetTag(tag)) current.hasFormula = true;
			else if (tag.local === "v" && isWorksheetTag(tag)) current.currentText = "value";
			else if (tag.local === "t" && isWorksheetTag(tag)) current.currentText = "inline";
		}
		elements.push({ local: tag.local ?? "", namespace, ...(row === undefined ? {} : { row }) });
	});
	sax.on("text", (text: string) => {
		if (current?.currentText === "value") current.value += text;
		else if (current?.currentText === "inline") current.inlineText += text;
	});
	sax.on("closetag", (tag: SaxesTag) => {
		if (current && isWorksheetTag(tag) && (tag.local === "v" || tag.local === "t")) {
			current.currentText = undefined;
		}
		if (current && tag.local === "c" && isWorksheetTag(tag)) {
			current.end = byteOffsets[sax.position];
			const resolved = cellValue(current, input.sharedStrings);
			cells.push({
				id: `${input.relationshipId}:${current.address}`,
				address: current.address,
				value: resolved.value,
				valueSha256: hashText(resolved.value),
				valueType: resolved.type,
				editable: !current.hasFormula && resolved.supported && !current.unsupportedStructure,
				...(!current.hasFormula && resolved.supported && !current.unsupportedStructure
					? {}
					: { blockedReason: current.hasFormula ? ("formula" as const) : ("unsupported-cell" as const) }),
				anchor: { part: input.part, start: current.start, end: current.end },
				...(current.styleId ? { styleId: current.styleId } : {}),
			});
			current = undefined;
		}
		elements.pop();
		depth--;
	});
	try {
		sax.write(xml).close();
	} catch (error) {
		if (error instanceof Error && error.name === "OfficeEngineError") throw error;
		throw officeError("XML_INVALID");
	}
	if (depth !== 0 || current || !validRoot) throw officeError("XML_INVALID");
	return { id: input.id, relationshipId: input.relationshipId, name: input.name, part: input.part, cells };
}

function cellValue(
	cell: CellBuilder,
	sharedStrings: readonly string[],
): { value: string; type: XlsxCellSnapshot["valueType"]; supported: boolean } {
	if (cell.cellType === "s") {
		const index = Number(cell.value);
		return Number.isSafeInteger(index) && index >= 0 && sharedStrings[index] !== undefined
			? { value: sharedStrings[index], type: "string", supported: true }
			: { value: "", type: "string", supported: false };
	}
	if (cell.cellType === "inlineStr" || cell.cellType === "str")
		return { value: cell.inlineText || cell.value, type: "string", supported: true };
	if (cell.cellType === "b")
		return {
			value: cell.value === "1" ? "TRUE" : "FALSE",
			type: "boolean",
			supported: cell.value === "0" || cell.value === "1",
		};
	if (cell.cellType === "e") return { value: cell.value, type: "error", supported: false };
	if (!cell.value) return { value: "", type: "blank", supported: true };
	return { value: cell.value, type: "number", supported: Number.isFinite(Number(cell.value)) };
}

function relationships(archive: PackageArchive, part: string): Relationship[] {
	const root = parseXml(archive.read(part), {
		root: "Relationships",
		namespaces: PACKAGE_RELATIONSHIP_NAMESPACES,
		rejectForeignElements: true,
	});
	const result = recordArray(child(childRecord(root, "Relationships"), "Relationship")).map((item) => ({
		Id: stringAttr(item, "Id"),
		Type: stringAttr(item, "Type"),
		Target: stringAttr(item, "Target"),
		...(typeof item["@_TargetMode"] === "string" ? { TargetMode: item["@_TargetMode"] } : {}),
	}));
	const ids = new Set<string>();
	const sourcePart = sourcePartForRelationships(part);
	for (const relationship of result) {
		if (ids.has(relationship.Id) || relationship.TargetMode?.toLowerCase() === "external")
			throw officeError("VALIDATION_FAILED");
		ids.add(relationship.Id);
		try {
			resolveOpcRelationshipTarget(relationship.Target, sourcePart);
		} catch {
			throw officeError("VALIDATION_FAILED");
		}
	}
	return result;
}

function sourcePartForRelationships(part: string): string | undefined {
	if (part === "_rels/.rels") return undefined;
	const marker = "/_rels/";
	const index = part.lastIndexOf(marker);
	if (index < 0 || !part.endsWith(".rels")) throw officeError("VALIDATION_FAILED");
	return `${part.slice(0, index + 1)}${part.slice(index + marker.length, -5)}`;
}
function parseContentTypes(bytes: Uint8Array): ContentTypes {
	const root = childRecord(
		parseXml(bytes, { root: "Types", namespaces: CONTENT_TYPE_NAMESPACES, rejectForeignElements: true }),
		"Types",
	);
	const defaults = new Map<string, string>();
	for (const item of recordArray(child(root, "Default"))) {
		const extension = stringAttr(item, "Extension").toLowerCase();
		if (!/^[a-z0-9]+$/u.test(extension) || defaults.has(extension)) throw officeError("VALIDATION_FAILED");
		defaults.set(extension, stringAttr(item, "ContentType"));
	}
	const overrides = new Map<string, string>();
	for (const item of recordArray(child(root, "Override"))) {
		const rawPart = stringAttr(item, "PartName");
		if (!rawPart.startsWith("/")) throw officeError("VALIDATION_FAILED");
		let part: string;
		try {
			part = resolveOpcRelationshipTarget(rawPart);
		} catch {
			throw officeError("VALIDATION_FAILED");
		}
		if (overrides.has(part)) throw officeError("VALIDATION_FAILED");
		overrides.set(part, stringAttr(item, "ContentType"));
	}
	return { defaults, overrides };
}

function contentTypeForPart(contentTypes: ContentTypes, part: string): string | undefined {
	const override = contentTypes.overrides.get(part);
	if (override) return override;
	const dot = part.lastIndexOf(".");
	return dot < 0 ? undefined : contentTypes.defaults.get(part.slice(dot + 1).toLowerCase());
}

function parseSharedStrings(bytes: Uint8Array): string[] {
	const root = parseXml(bytes, {
		root: "sst",
		namespaces: WORKSHEET_NAMESPACES,
		rejectForeignElements: true,
	});
	return recordArray(child(childRecord(root, "sst"), "si")).map((item) => collectText(item));
}

function collectText(value: unknown): string {
	if (typeof value === "string") return decodeXmlEntities(value);
	if (typeof value === "number") return String(value);
	if (Array.isArray(value)) return value.map(collectText).join("");
	if (!value || typeof value !== "object") return "";
	const item = value as Record<string, unknown>;
	if ("t" in item) return collectText(item.t);
	return Object.entries(item)
		.filter(([key]) => !key.startsWith("@_"))
		.map(([, child]) => collectText(child))
		.join("");
}

function resolveTarget(sourcePart: string, target: string): string {
	try {
		return resolveOpcRelationshipTarget(target, sourcePart || undefined);
	} catch {
		throw officeError("VALIDATION_FAILED");
	}
}
function relationshipPart(part: string): string {
	const slash = part.lastIndexOf("/");
	return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}
interface XmlNamespacePolicy {
	readonly root: string;
	readonly namespaces: ReadonlySet<string>;
	readonly semanticElements?: ReadonlySet<string>;
	readonly rejectForeignElements?: boolean;
}
function parseXml(bytes: Uint8Array, policy: XmlNamespacePolicy): Record<string, unknown> {
	if (bytes.length > MAX_XML_BYTES) throw officeError("XML_TOO_LARGE");
	try {
		const xml = decode(bytes);
		const withoutDeclaration = xml.replace(/^\s*<\?xml[^?]*\?>/iu, "");
		if (/<!DOCTYPE|<\?/iu.test(withoutDeclaration)) throw officeError("XML_DTD_FORBIDDEN");
		validateXmlStructure(xml, policy);
		return record(parser.parse(xml));
	} catch (error) {
		if (error instanceof Error && error.name === "OfficeEngineError") throw error;
		throw officeError("XML_INVALID");
	}
}
function validateXmlStructure(xml: string, policy: XmlNamespacePolicy): void {
	let depth = 0;
	let nodes = 0;
	let rootSeen = false;
	const sax = new SaxesParser({ xmlns: true, position: false });
	sax.on("doctype", () => {
		throw officeError("XML_DTD_FORBIDDEN");
	});
	sax.on("processinginstruction", (item) => {
		if (item.target.toLowerCase() !== "xml") throw officeError("XML_PI_FORBIDDEN");
	});
	sax.on("opentag", (tag: SaxesTag) => {
		depth++;
		nodes++;
		if (depth > MAX_XML_DEPTH || nodes > MAX_XML_NODES) throw officeError("XML_INVALID");
		const namespace = typeof tag.uri === "string" ? tag.uri : "";
		const local = tag.local ?? "";
		if (depth === 1) {
			if (rootSeen || local !== policy.root || !policy.namespaces.has(namespace)) throw officeError("XML_INVALID");
			rootSeen = true;
		}
		if ((policy.rejectForeignElements || policy.semanticElements?.has(local)) && !policy.namespaces.has(namespace)) {
			throw officeError("XML_INVALID");
		}
	});
	sax.on("closetag", () => {
		depth--;
	});
	sax.write(xml).close();
	if (depth !== 0 || !rootSeen) throw officeError("XML_INVALID");
}
function child(value: Record<string, unknown>, key: string): unknown {
	return value[key];
}
function childRecord(value: Record<string, unknown>, key: string): Record<string, unknown> {
	const item = child(value, key);
	if (!item || typeof item !== "object" || Array.isArray(item)) throw officeError("VALIDATION_FAILED");
	return item as Record<string, unknown>;
}
function decode(bytes: Uint8Array): string {
	try {
		return decoder.decode(bytes);
	} catch {
		throw officeError("XML_INVALID");
	}
}
function arrayOf<T>(value: T | T[] | undefined): T[] {
	return value === undefined ? [] : Array.isArray(value) ? value : [value];
}
function recordArray(value: unknown): Record<string, unknown>[] {
	return arrayOf(value).map(record);
}
function stringAttr(value: Record<string, unknown>, key: string): string {
	const result = value[`@_${key}`];
	if (typeof result !== "string" || !result) throw officeError("VALIDATION_FAILED");
	return decodeXmlEntities(result);
}
function decodeXmlEntities(value: string): string {
	return value.replace(/&(amp|lt|gt|quot|apos|#(?:[0-9]+|x[0-9a-f]+));/giu, (_entity, reference: string) => {
		const named: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
		const replacement = named[reference.toLowerCase()];
		if (replacement !== undefined) return replacement;
		const hexadecimal = reference[1]?.toLowerCase() === "x";
		const codePoint = Number.parseInt(reference.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
		if (!Number.isSafeInteger(codePoint) || !validXmlCodePoint(codePoint)) throw officeError("XML_INVALID");
		return String.fromCodePoint(codePoint);
	});
}
function validXmlCodePoint(codePoint: number): boolean {
	return (
		codePoint === 0x9 ||
		codePoint === 0xa ||
		codePoint === 0xd ||
		(codePoint >= 0x20 && codePoint <= 0xd7ff) ||
		(codePoint >= 0xe000 && codePoint <= 0xfffd) ||
		(codePoint >= 0x10000 && codePoint <= 0x10ffff)
	);
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw officeError("VALIDATION_FAILED");
	return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
		throw officeError("VALIDATION_FAILED");
}
function boundedString(value: unknown, max = 256, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && !value) || encoder.encode(value).length > max)
		throw officeError("VALIDATION_FAILED");
	return value;
}
function isWorksheetTag(tag: SaxesTag): boolean {
	return typeof tag.uri === "string" && WORKSHEET_NAMESPACES.has(tag.uri);
}
function attribute(tag: SaxesTag, local: string): string {
	for (const value of Object.values(tag.attributes))
		if (typeof value !== "string" && value.local === local && value.uri === "") return value.value;
	return "";
}
function modeledCellAttributes(tag: SaxesTag): boolean {
	return Object.values(tag.attributes).every(
		(value) => typeof value !== "string" && value.uri === "" && MODELED_CELL_ATTRIBUTES.has(value.local),
	);
}
function validCellAddress(address: string): boolean {
	return parseCellAddress(address) !== undefined;
}
function parseCellAddress(address: string): { readonly column: number; readonly row: number } | undefined {
	const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/u.exec(address);
	if (!match) return undefined;
	let column = 0;
	for (const character of match[1]!) column = column * 26 + character.charCodeAt(0) - 64;
	const row = Number(match[2]);
	return column <= MAX_XLSX_COLUMN && row <= MAX_XLSX_ROW ? { column, row } : undefined;
}
function tagStart(xml: string, position: number): number {
	let index = Math.max(0, position - 1);
	while (index > 0 && xml[index] !== "<") index--;
	return index;
}
function offsets(value: string): Uint32Array {
	const map = new Uint32Array(value.length + 1);
	let bytes = 0;
	for (let index = 0; index < value.length; index++) {
		map[index] = bytes;
		const code = value.charCodeAt(index);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
			bytes += 4;
			map[++index] = bytes;
		} else bytes += 3;
	}
	map[value.length] = bytes;
	return map;
}
function validXmlText(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (
			code === 0x9 ||
			code === 0xa ||
			code === 0xd ||
			(code >= 0x20 && code <= 0xd7ff) ||
			(code >= 0xe000 && code <= 0xfffd)
		)
			continue;
		if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
			const low = value.charCodeAt(++index);
			if (low >= 0xdc00 && low <= 0xdfff) continue;
		}
		return false;
	}
	return true;
}
function hashText(value: string): string {
	return hex(sha256(encoder.encode(value)));
}
function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function escapeText(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function escapeAttribute(value: string): string {
	return escapeText(value).replaceAll('"', "&quot;");
}
function concat(chunks: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.length;
	}
	return output;
}
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
