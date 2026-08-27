import type { PackageArchive } from "./archive.ts";
import { decodeAndValidateXmlPart, resolveDocx } from "./docx.ts";
import { officeError } from "./errors.ts";

const WORDPROCESSINGML_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const STRICT_WORDPROCESSINGML_NAMESPACE = "http://purl.oclc.org/ooxml/wordprocessingml/main";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";

export type DocxUnsupportedKind =
	| "section"
	| "table"
	| "drawing"
	| "field"
	| "revision"
	| "content_control"
	| "hyperlink"
	| "unknown"
	| "unsafe";

export interface DocxPresence {
	readonly section: boolean;
	readonly table: boolean;
	readonly drawing: boolean;
	readonly field: boolean;
	readonly revision: boolean;
	readonly content_control: boolean;
	readonly hyperlink: boolean;
	readonly unknown: boolean;
	readonly unsafe: boolean;
}

export type DocxBlockedReason =
	| "section"
	| "table"
	| "drawing"
	| "field"
	| "tracked_revision"
	| "content_control"
	| "hyperlink"
	| "multiple_text_nodes"
	| "non_text_child"
	| "unknown_markup"
	| "unsafe_structure";

export interface DocxRunProperties {
	readonly bold?: boolean;
	readonly italic?: boolean;
	readonly styleId?: string;
}

export interface DocxTextRunSnapshot {
	readonly id: string;
	readonly text: string;
	readonly properties: DocxRunProperties;
	readonly editable: boolean;
	readonly blockedReason?: DocxBlockedReason;
}

export interface DocxParagraphSnapshot {
	readonly id: string;
	readonly runs: ReadonlyArray<DocxTextRunSnapshot>;
	readonly presence: DocxPresence;
}

export interface DocxDocumentSnapshot {
	readonly format: "docx";
	readonly mainPartPath: string;
	readonly paragraphs: ReadonlyArray<DocxParagraphSnapshot>;
	readonly presence: DocxPresence;
}

type NamespaceBindings = ReadonlyMap<string, string>;
interface ScanTextNode {
	readonly kind: "text";
	readonly value: string;
	readonly start: number;
	readonly end: number;
}
interface ScanOpaqueNode {
	readonly kind: "opaque";
	readonly start: number;
	readonly end: number;
}
interface ScanElement {
	readonly kind: "element";
	readonly qName: string;
	readonly local: string;
	readonly namespace: string | undefined;
	readonly bindings: NamespaceBindings;
	readonly attributes: ReadonlyArray<ScanAttribute>;
	readonly children: ReadonlyArray<ScanNode>;
	readonly start: number;
	readonly startEnd: number;
	readonly endStart: number;
	readonly end: number;
	readonly selfClosing: boolean;
}
interface ScanAttribute {
	readonly qName: string;
	readonly local: string;
	readonly namespace: string | undefined;
	readonly value: string;
}
type ScanNode = ScanElement | ScanTextNode | ScanOpaqueNode;

export interface DocxRawAnchor {
	readonly run: { readonly start: number; readonly end: number };
	readonly text?: { readonly start: number; readonly end: number };
	readonly textElement?: { readonly start: number; readonly end: number };
}

export interface DocxDocumentModel {
	readonly snapshot: DocxDocumentSnapshot;
	readonly source: Uint8Array;
	readonly rawAnchors: ReadonlyMap<string, DocxRawAnchor>;
}

const RPR_KNOWN_PROPERTIES = new Set([
	"b",
	"bold",
	"i",
	"italic",
	"rStyle",
	"rFonts",
	"color",
	"sz",
	"szCs",
	"u",
	"strike",
	"dstrike",
	"caps",
	"smallCaps",
	"vanish",
	"vertAlign",
	"lang",
	"spacing",
	"kern",
	"position",
	"w",
	"outline",
	"shadow",
	"emboss",
	"imprint",
	"noProof",
	"snapToGrid",
	"rtl",
	"cs",
	"bCs",
	"iCs",
	"webHidden",
]);
const KNOWN_PARAGRAPH_ELEMENTS = new Set([
	"p",
	"pPr",
	"pStyle",
	"spacing",
	"jc",
	"numPr",
	"keepNext",
	"keepLines",
	"pageBreakBefore",
	"widowControl",
	"tabs",
	"ind",
	"contextualSpacing",
	"mirrorIndents",
	"textDirection",
	"textAlignment",
	"outlineLvl",
	"ilvl",
	"numId",
	"r",
	"rPr",
	"rStyle",
	...RPR_KNOWN_PROPERTIES,
	"t",
	"tab",
	"br",
	"cr",
	"noBreakHyphen",
	"softHyphen",
	"sym",
	"delText",
	"fldChar",
	"instrText",
	"fldSimple",
	"ins",
	"del",
	"moveFrom",
	"moveTo",
	"sdt",
	"sdtPr",
	"sdtContent",
	"hyperlink",
	"drawing",
	"pict",
	"object",
	"txbxContent",
	"proofErr",
	"permStart",
	"permEnd",
	"bookmarkStart",
	"bookmarkEnd",
	"commentRangeStart",
	"commentRangeEnd",
	"commentReference",
	"lastRenderedPageBreak",
	"sectPr",
	"tbl",
]);
const UNSUPPORTED_WRAPPERS = new Map<string, DocxUnsupportedKind>([
	["sectPr", "section"],
	["tbl", "table"],
	["drawing", "drawing"],
	["pict", "drawing"],
	["object", "drawing"],
	["fldSimple", "field"],
	["fldChar", "field"],
	["instrText", "field"],
	["ins", "revision"],
	["del", "revision"],
	["moveFrom", "revision"],
	["moveTo", "revision"],
	["sdt", "content_control"],
	["hyperlink", "hyperlink"],
]);

const BLOCK_PRIORITY: ReadonlyArray<DocxBlockedReason> = [
	"unsafe_structure",
	"tracked_revision",
	"field",
	"content_control",
	"drawing",
	"hyperlink",
	"table",
	"section",
	"unknown_markup",
	"multiple_text_nodes",
	"non_text_child",
];

function emptyPresence(): Record<DocxUnsupportedKind, boolean> {
	return {
		section: false,
		table: false,
		drawing: false,
		field: false,
		revision: false,
		content_control: false,
		hyperlink: false,
		unknown: false,
		unsafe: false,
	};
}

function markPresenceUnsafe(presence: Record<DocxUnsupportedKind, boolean>): void {
	presence.unsafe = true;
}

function findTagEnd(source: string, start: number): number {
	let quote = "";
	for (let index = start; index < source.length; index += 1) {
		const character = source[index];
		if (quote !== "") {
			if (character === quote) quote = "";
		} else if (character === '"' || character === "'") {
			quote = character;
		} else if (character === ">") {
			return index;
		}
	}
	return -1;
}

function hasUnsafeTextContent(element: ScanElement): boolean {
	return element.children.some((child) => child.kind !== "text");
}

function directTextNodes(node: ScanElement): ReadonlyArray<ScanTextNode> {
	return node.children.filter((child): child is ScanTextNode => child.kind === "text");
}

function isWordNamespace(namespace: string | undefined): boolean {
	return namespace === WORDPROCESSINGML_NAMESPACE || namespace === STRICT_WORDPROCESSINGML_NAMESPACE;
}

function qNameParts(qName: string): { readonly prefix: string; readonly local: string } {
	const separator = qName.indexOf(":");
	return separator < 0
		? { prefix: "", local: qName }
		: { prefix: qName.slice(0, separator), local: qName.slice(separator + 1) };
}

function decodeXmlValue(value: string): string {
	return value.replace(/&(#(?:[xX][0-9a-fA-F]+|[0-9]+)|[A-Za-z_][A-Za-z0-9_.:-]*);/g, (_match, reference: string) => {
		if (reference === "amp") return "&";
		if (reference === "quot") return '"';
		if (reference === "lt") return "<";
		if (reference === "gt") return ">";
		if (reference === "apos") return "'";
		const codePoint =
			reference.startsWith("#x") || reference.startsWith("#X")
				? Number.parseInt(reference.slice(2), 16)
				: Number.parseInt(reference.slice(1), 10);
		if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
			throw officeError("XML_ENTITY_FORBIDDEN");
		}
		return String.fromCodePoint(codePoint);
	});
}

function byteOffsets(xml: string): Uint32Array {
	const result = new Uint32Array(xml.length + 1);
	let offset = 0;
	for (let index = 0; index < xml.length; ) {
		const codePoint = xml.codePointAt(index);
		if (codePoint === undefined) throw officeError("XML_INVALID");
		const width = codePoint > 0xffff ? 2 : 1;
		result[index] = offset;
		if (width === 2) result[index + 1] = offset;
		const byteWidth = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
		offset += byteWidth;
		index += width;
	}
	result[xml.length] = offset;
	return result;
}

function parseAttributes(source: string, start: number, end: number): ScanAttribute[] {
	const attributes: ScanAttribute[] = [];
	let cursor = start;
	while (cursor < end) {
		while (cursor < end && /\s/.test(source[cursor])) cursor += 1;
		if (cursor >= end) break;
		const nameStart = cursor;
		while (cursor < end && !/[\s=]/.test(source[cursor])) cursor += 1;
		const qName = source.slice(nameStart, cursor);
		if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(qName)) throw officeError("XML_INVALID");
		while (cursor < end && /\s/.test(source[cursor])) cursor += 1;
		if (source[cursor] !== "=") throw officeError("XML_INVALID");
		cursor += 1;
		while (cursor < end && /\s/.test(source[cursor])) cursor += 1;
		const quote = source[cursor];
		if (quote !== '"' && quote !== "'") throw officeError("XML_INVALID");
		cursor += 1;
		const valueStart = cursor;
		const valueEnd = source.indexOf(quote, cursor);
		if (valueEnd < 0 || valueEnd > end) throw officeError("XML_INVALID");
		const value = decodeXmlValue(source.slice(valueStart, valueEnd));
		const parts = qNameParts(qName);
		attributes.push({ qName, local: parts.local, namespace: undefined, value });
		cursor = valueEnd + 1;
	}
	return attributes;
}

function scanXml(bytes: Uint8Array): {
	readonly root: ScanElement;
	readonly xml: string;
	readonly offsets: Uint32Array;
	readonly rootOpaque: boolean;
} {
	const xml = decodeAndValidateXmlPart(bytes);
	const offsets = byteOffsets(xml);
	const stack: Array<{ readonly qName: string; readonly node: ScanElement; readonly children: ScanNode[] }> = [];
	let root: ScanElement | undefined;
	let rootOpaque = false;
	let cursor = 0;
	while (cursor < xml.length) {
		if (xml[cursor] !== "<") {
			const next = xml.indexOf("<", cursor);
			const end = next < 0 ? xml.length : next;
			if (stack.length > 0 && end > cursor) {
				stack[stack.length - 1].children.push({
					kind: "text",
					value: decodeXmlValue(xml.slice(cursor, end)),
					start: cursor,
					end,
				});
			} else if (end > cursor && xml.slice(cursor, end).trim().length > 0) {
				rootOpaque = true;
			}
			cursor = end;
			continue;
		}
		if (xml.startsWith("<!--", cursor)) {
			const end = xml.indexOf("-->", cursor + 4);
			if (end < 0) throw officeError("XML_INVALID");
			if (stack.length > 0) stack[stack.length - 1].children.push({ kind: "opaque", start: cursor, end: end + 3 });
			else rootOpaque = true;
			cursor = end + 3;
			continue;
		}
		if (xml.startsWith("<![CDATA[", cursor)) {
			const end = xml.indexOf("]]>", cursor + 9);
			if (end < 0) throw officeError("XML_INVALID");
			if (stack.length > 0) stack[stack.length - 1].children.push({ kind: "opaque", start: cursor, end: end + 3 });
			else rootOpaque = true;
			cursor = end + 3;
			continue;
		}
		if (xml.startsWith("<?", cursor)) {
			const end = xml.indexOf("?>", cursor + 2);
			if (end < 0) throw officeError("XML_INVALID");
			if (stack.length > 0) stack[stack.length - 1].children.push({ kind: "opaque", start: cursor, end: end + 2 });
			else if (!/^<\?xml\b/i.test(xml.slice(cursor, end + 2))) rootOpaque = true;
			cursor = end + 2;
			continue;
		}
		if (xml.startsWith("</", cursor)) {
			const end = xml.indexOf(">", cursor + 2);
			if (end < 0 || stack.length === 0) throw officeError("XML_INVALID");
			const qName = xml.slice(cursor + 2, end).trim();
			const current = stack.pop();
			if (current === undefined || current.qName !== qName) throw officeError("XML_INVALID");
			const completed: ScanElement = { ...current.node, children: current.children, endStart: cursor, end: end + 1 };
			if (stack.length > 0) stack[stack.length - 1].children.push(completed);
			else if (root === undefined) root = completed;
			else throw officeError("XML_INVALID");
			cursor = end + 1;
			continue;
		}
		const end = findTagEnd(xml, cursor + 1);
		if (end < 0) throw officeError("XML_INVALID");
		let tagEnd = end;
		while (tagEnd > cursor && /\s/.test(xml[tagEnd - 1])) tagEnd -= 1;
		const selfClosing = xml[tagEnd - 1] === "/";
		const contentEnd = selfClosing ? tagEnd - 1 : tagEnd;
		const nameMatch = xml.slice(cursor + 1, contentEnd).match(/^\s*([A-Za-z_][A-Za-z0-9_.:-]*)/);
		if (nameMatch === null) throw officeError("XML_INVALID");
		const qName = nameMatch[1];
		const attributeStart = cursor + 1 + nameMatch[0].length;
		const attributes = parseAttributes(xml, attributeStart, contentEnd);
		const inherited = stack.length === 0 ? new Map<string, string>() : stack[stack.length - 1].node.bindings;
		const bindings = new Map(inherited);
		for (const attribute of attributes) {
			if (attribute.qName === "xmlns") bindings.set("", attribute.value);
			else if (attribute.qName.startsWith("xmlns:")) bindings.set(attribute.qName.slice(6), attribute.value);
		}
		const namespacedAttributes = attributes.map((item) => {
			const parts = qNameParts(item.qName);
			const namespace =
				item.qName === "xmlns" || parts.prefix === "xmlns"
					? XML_NAMESPACE
					: parts.prefix === "xml"
						? XML_NAMESPACE
						: parts.prefix === ""
							? undefined
							: bindings.get(parts.prefix);
			if (parts.prefix !== "" && parts.prefix !== "xml" && parts.prefix !== "xmlns" && namespace === undefined) {
				throw officeError("DOCX_DOCUMENT_UNSAFE");
			}
			return { ...item, namespace };
		});
		const parts = qNameParts(qName);
		const namespace = bindings.get(parts.prefix);
		if (parts.prefix !== "" && namespace === undefined) throw officeError("DOCX_DOCUMENT_UNSAFE");
		const node: ScanElement = {
			kind: "element",
			qName,
			local: parts.local,
			namespace,
			bindings,
			attributes: namespacedAttributes,
			children: [],
			start: cursor,
			startEnd: end + 1,
			endStart: end + 1,
			end: end + 1,
			selfClosing,
		};
		if (selfClosing) {
			const completed: ScanElement = { ...node, endStart: end + 1, end: end + 1 };
			if (stack.length > 0) stack[stack.length - 1].children.push(completed);
			else if (root === undefined) root = completed;
			else throw officeError("XML_INVALID");
		} else {
			if (stack.length >= 100) throw officeError("XML_INVALID");
			stack.push({ qName, node, children: [] });
		}
		cursor = end + 1;
	}
	if (stack.length !== 0 || root === undefined) throw officeError("XML_INVALID");
	return { root, xml, offsets, rootOpaque };
}

function directElements(node: ScanElement): ReadonlyArray<ScanElement> {
	return node.children.filter((child): child is ScanElement => child.kind === "element");
}

function attribute(element: ScanElement, local: string, namespace?: string): string | undefined {
	return element.attributes.find((item) => item.local === local && item.namespace === namespace)?.value;
}

function mark(presence: Record<DocxUnsupportedKind, boolean>, kind: DocxUnsupportedKind): void {
	presence[kind] = true;
}

function recognizedRunProperty(local: string): boolean {
	return RPR_KNOWN_PROPERTIES.has(local);
}

function propertyBoolean(element: ScanElement, local: string): boolean | undefined {
	const child = directElements(element).find((item) => item.local === local && isWordNamespace(item.namespace));
	if (child === undefined) return undefined;
	const value = attribute(child, "val", child.namespace);
	return value === undefined || !["false", "0", "off", "no"].includes(value.toLowerCase());
}

function selectBlocked(reasons: ReadonlyArray<DocxBlockedReason>): DocxBlockedReason | undefined {
	for (const candidate of BLOCK_PRIORITY) if (reasons.includes(candidate)) return candidate;
	return undefined;
}

function snapshotPresence(presence: Record<DocxUnsupportedKind, boolean>): DocxPresence {
	return { ...presence };
}

function parseParagraph(
	paragraph: ScanElement,
	paragraphId: string,
	paragraphIndex: number,
	globalPresence: Record<DocxUnsupportedKind, boolean>,
	rawAnchors: Map<string, DocxRawAnchor>,
	offsets: Uint32Array,
): DocxParagraphSnapshot {
	const presence = emptyPresence();
	const runs: Array<{
		readonly element: ScanElement;
		readonly contexts: ReadonlyArray<DocxUnsupportedKind>;
		readonly blocked: ReadonlyArray<DocxBlockedReason>;
	}> = [];
	const paragraphReasons: DocxBlockedReason[] = [];
	const visit = (
		element: ScanElement,
		contexts: ReadonlyArray<DocxUnsupportedKind>,
		path: ReadonlyArray<string>,
	): void => {
		const nextContexts = [...contexts];
		const nextReasons: DocxBlockedReason[] = [];
		for (const child of element.children) {
			if (
				child.kind === "opaque" ||
				(child.kind === "text" &&
					(!isWordNamespace(element.namespace) || (element.local !== "t" && element.local !== "instrText")) &&
					child.value.trim().length > 0)
			) {
				mark(presence, "unknown");
				mark(globalPresence, "unknown");
				markPresenceUnsafe(presence);
				markPresenceUnsafe(globalPresence);
				nextReasons.push("unsafe_structure");
				paragraphReasons.push("unsafe_structure");
			}
		}
		if (!isWordNamespace(element.namespace)) {
			mark(presence, "unknown");
			mark(globalPresence, "unknown");
			nextReasons.push("unknown_markup");
			paragraphReasons.push("unknown_markup");
		}
		if (isWordNamespace(element.namespace)) {
			const kind = UNSUPPORTED_WRAPPERS.get(element.local);
			if (kind !== undefined) {
				mark(presence, kind);
				mark(globalPresence, kind);
				nextContexts.push(kind);
				if (kind === "field" && (element.local === "fldChar" || element.local === "instrText")) {
					paragraphReasons.push("field");
				} else if (kind === "table") {
					paragraphReasons.push("table");
				} else if (kind === "section") {
					paragraphReasons.push("section");
				}
			}
			if (element.local !== "r" && !KNOWN_PARAGRAPH_ELEMENTS.has(element.local)) {
				mark(presence, "unknown");
				mark(globalPresence, "unknown");
				paragraphReasons.push("unknown_markup");
				nextReasons.push("unknown_markup");
			}
		}
		if (element.local === "r" && isWordNamespace(element.namespace)) {
			if (path.length > 0 && nextContexts.length === 0) {
				mark(presence, "unsafe");
				mark(globalPresence, "unsafe");
				nextReasons.push("unsafe_structure");
				paragraphReasons.push("unsafe_structure");
			}
			runs.push({ element, contexts: nextContexts, blocked: nextReasons });
		}
		for (const child of directElements(element)) visit(child, nextContexts, [...path, element.local]);
	};
	for (const child of paragraph.children) {
		if (child.kind === "opaque") {
			mark(presence, "unknown");
			mark(globalPresence, "unknown");
			markPresenceUnsafe(presence);
			markPresenceUnsafe(globalPresence);
			paragraphReasons.push("unsafe_structure");
			continue;
		}
		if (child.kind === "text") {
			if (child.value.trim().length > 0) {
				mark(presence, "unsafe");
				mark(globalPresence, "unsafe");
				paragraphReasons.push("unsafe_structure");
			}
			continue;
		}
		visit(child, [], []);
	}
	const paragraphBlocked = selectBlocked(paragraphReasons);
	const snapshots: DocxTextRunSnapshot[] = [];
	for (const item of runs) {
		const runId = `r-${paragraphIndex}-${snapshots.length}`;
		const textNodes = directElements(item.element).filter(
			(child) => child.local === "t" && isWordNamespace(child.namespace),
		);
		const text = textNodes
			.map((node) =>
				directTextNodes(node)
					.map((child) => child.value)
					.join(""),
			)
			.join("");
		const reasons: DocxBlockedReason[] = [...item.blocked];
		for (const context of item.contexts) {
			if (context === "revision") reasons.push("tracked_revision");
			else if (context === "field") reasons.push("field");
			else if (context === "content_control") reasons.push("content_control");
			else if (context === "drawing") reasons.push("drawing");
			else if (context === "hyperlink") reasons.push("hyperlink");
			else if (context === "table") reasons.push("table");
			else if (context === "section") reasons.push("section");
			else if (context === "unknown") reasons.push("unknown_markup");
		}
		const nestedKinds: DocxUnsupportedKind[] = [];
		const collectNestedKinds = (element: ScanElement): void => {
			if (isWordNamespace(element.namespace)) {
				const kind = UNSUPPORTED_WRAPPERS.get(element.local);
				if (kind !== undefined) nestedKinds.push(kind);
			}
			for (const child of directElements(element)) collectNestedKinds(child);
		};
		collectNestedKinds(item.element);
		for (const kind of nestedKinds) {
			if (kind === "revision") reasons.push("tracked_revision");
			else if (kind === "field") reasons.push("field");
			else if (kind === "content_control") reasons.push("content_control");
			else if (kind === "drawing") reasons.push("drawing");
			else if (kind === "hyperlink") reasons.push("hyperlink");
			else if (kind === "table") reasons.push("table");
			else if (kind === "section") reasons.push("section");
		}
		if (textNodes.length > 1) reasons.push("multiple_text_nodes");
		if (textNodes.length === 0) reasons.push("non_text_child");
		if (textNodes.some((node) => node.selfClosing)) reasons.push("unsafe_structure");
		if (textNodes.some((node) => hasUnsafeTextContent(node))) reasons.push("non_text_child");
		const directChildren = directElements(item.element);
		const rPrNodes = directChildren.filter((child) => child.local === "rPr" && isWordNamespace(child.namespace));
		const firstTextIndex = directChildren.findIndex(
			(child) => child.local === "t" && isWordNamespace(child.namespace),
		);
		const firstRPrIndex = directChildren.findIndex(
			(child) => child.local === "rPr" && isWordNamespace(child.namespace),
		);
		if (rPrNodes.length > 1 || (firstTextIndex >= 0 && firstRPrIndex >= 0 && firstTextIndex < firstRPrIndex)) {
			reasons.push("unsafe_structure");
		}
		if (directTextNodes(item.element).some((node) => node.value.trim().length > 0)) reasons.push("unsafe_structure");
		const rPr = rPrNodes[0];
		const properties: { bold?: boolean; italic?: boolean; styleId?: string } = {};
		if (rPr !== undefined) {
			const bold = propertyBoolean(rPr, "b");
			const italic = propertyBoolean(rPr, "i");
			const style = directElements(rPr).find(
				(child) => child.local === "rStyle" && isWordNamespace(child.namespace),
			);
			if (bold !== undefined) properties.bold = bold;
			if (italic !== undefined) properties.italic = italic;
			const styleId = style === undefined ? undefined : attribute(style, "val", style.namespace);
			if (styleId !== undefined && styleId.length > 0) properties.styleId = styleId;
			for (const child of directElements(rPr))
				if (!recognizedRunProperty(child.local)) reasons.push("unknown_markup");
		}
		for (const child of directElements(item.element)) {
			if (child.local !== "rPr" && child.local !== "t" && isWordNamespace(child.namespace))
				reasons.push("non_text_child");
			if (!isWordNamespace(child.namespace)) reasons.push("unknown_markup");
		}
		if (paragraphBlocked !== undefined) reasons.push(paragraphBlocked);
		const blockedReason = selectBlocked(reasons);
		const anchorElement = item.element;
		rawAnchors.set(runId, {
			run: { start: offsets[anchorElement.start], end: offsets[anchorElement.end] },
			...(blockedReason === undefined && textNodes.length === 1 && !hasUnsafeTextContent(textNodes[0])
				? {
						text: { start: offsets[textNodes[0].startEnd], end: offsets[textNodes[0].endStart] },
						textElement: { start: offsets[textNodes[0].start], end: offsets[textNodes[0].end] },
					}
				: {}),
		});
		snapshots.push({
			id: runId,
			text,
			properties,
			editable: blockedReason === undefined,
			...(blockedReason === undefined ? {} : { blockedReason }),
		});
	}
	return { id: paragraphId, runs: snapshots, presence: snapshotPresence(presence) };
}
export function parseDocxDocument(bytes: Uint8Array, mainPartPath?: string): DocxDocumentModel {
	const scanned = scanXml(bytes);
	if (scanned.root.local !== "document" || !isWordNamespace(scanned.root.namespace))
		throw officeError("DOCX_DOCUMENT_INVALID");
	const presence = emptyPresence();
	const rootBodies = directElements(scanned.root).filter(
		(child) => child.local === "body" && child.namespace === scanned.root.namespace,
	);
	if (rootBodies.length !== 1) throw officeError("DOCX_DOCUMENT_INVALID");
	const body = rootBodies[0];
	const rawAnchors = new Map<string, DocxRawAnchor>();
	const paragraphs: DocxParagraphSnapshot[] = [];
	if (scanned.rootOpaque) {
		mark(presence, "unknown");
		markPresenceUnsafe(presence);
	}
	for (const child of scanned.root.children) {
		if (child.kind === "opaque") {
			mark(presence, "unknown");
			markPresenceUnsafe(presence);
		} else if (child.kind === "text" && child.value.trim().length > 0) {
			mark(presence, "unsafe");
			markPresenceUnsafe(presence);
		} else if (child.kind === "element" && child !== body) {
			mark(presence, "unknown");
		}
	}
	const bodyChildren = body.children;
	let paragraphIndex = 0;
	for (const child of bodyChildren) {
		if (child.kind === "opaque") {
			mark(presence, "unknown");
			markPresenceUnsafe(presence);
			continue;
		}
		if (child.kind === "text") {
			if (child.value.trim().length > 0) {
				mark(presence, "unsafe");
				markPresenceUnsafe(presence);
			}
			continue;
		}
		if (child.local === "p" && child.namespace === scanned.root.namespace) {
			paragraphs.push(
				parseParagraph(child, `p-${paragraphIndex}`, paragraphIndex, presence, rawAnchors, scanned.offsets),
			);
			paragraphIndex += 1;
		} else if (child.local === "sectPr" && child.namespace === scanned.root.namespace) {
			mark(presence, "section");
		} else if (child.local === "tbl" && child.namespace === scanned.root.namespace) {
			mark(presence, "table");
		} else {
			mark(presence, "unknown");
		}
	}
	return {
		snapshot: { format: "docx", mainPartPath: mainPartPath ?? "", paragraphs, presence: snapshotPresence(presence) },
		source: new Uint8Array(bytes),
		rawAnchors,
	};
}

export function inspectDocx(archive: PackageArchive): DocxDocumentSnapshot {
	const resolution = resolveDocx(archive);
	return parseDocxDocument(archive.read(resolution.mainPart.path), resolution.mainPart.path).snapshot;
}

export function inspectDocxModel(archive: PackageArchive): DocxDocumentModel {
	const resolution = resolveDocx(archive);
	return parseDocxDocument(archive.read(resolution.mainPart.path), resolution.mainPart.path);
}
