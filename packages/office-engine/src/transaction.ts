import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { type SaxesAttributeNS, SaxesParser, type SaxesTag } from "saxes";
import { PackageArchive, verifyReplacement } from "./archive.ts";
import { resolveDocx } from "./docx.ts";
import { officeError } from "./errors.ts";
import {
	type CommentSnapshot,
	inspectCommentsWordPart,
	inspectRelatedWordPart,
	type RelatedPartRunSnapshot,
	type RelatedPartSnapshot,
} from "./related-parts.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export const TRANSACTION_BUDGETS = Object.freeze({
	maxEnvelopeBytes: 1_048_576,
	maxOperations: 100,
	maxTouchedRuns: 100,
	maxIdBytes: 256,
	maxExpectedTextBytes: 100_000,
	maxReplacementBytes: 100_000,
	maxOperationsExpectedBytes: 2_000_000,
	maxOperationsReplacementBytes: 2_000_000,
	maxSemanticDiffBytes: 2_000_000,
	maxDecodedManifestReplacementBytes: 2_000_000,
	maxPatchReplacementBytes: 2_000_000,
	maxPlanBytes: 8_000_000,
	maxXmlBytes: 16 * 1024 * 1024,
	maxXmlDepth: 256,
	maxXmlNodes: 200_000,
});
const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const STRICT_WORD_NS = "http://purl.oclc.org/ooxml/wordprocessingml/main";
const hex = (value: Uint8Array): string => Array.from(value, (x) => x.toString(16).padStart(2, "0")).join("");
export const sha256Hex = (value: Uint8Array): string => hex(nobleSha256(value));
const sha256 = sha256Hex;
const b64 = (value: Uint8Array): string => {
	let result = "";
	for (let index = 0; index < value.length; index += 1) result += String.fromCharCode(value[index]);
	return globalThis.btoa(result);
};
const fromB64 = (value: string): Uint8Array => {
	const binary = globalThis.atob(value);
	const result = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
	return result;
};

export type DocxBlockedReason =
	| "bookmark-boundary"
	| "comment-boundary"
	| "note-reference"
	| "field-boundary"
	| "tracked-revision"
	| "content-control"
	| "hyperlink-boundary"
	| "drawing-content"
	| "textbox-content"
	| "foreign-namespace"
	| "invalid-run-property"
	| "complex-run"
	| "xml-cdata"
	| "xml-comment"
	| "unsupported-paragraph-boundary";

export interface DocxTextRunSnapshot {
	readonly id: string;
	readonly text: string;
	readonly properties: { readonly bold?: boolean; readonly italic?: boolean; readonly styleId?: string };
	readonly editable: boolean;
	readonly blockedReason?: DocxBlockedReason;
	readonly anchor: {
		readonly part: string;
		readonly start: number;
		readonly end: number;
		readonly textStart: number;
		readonly textEnd: number;
		readonly textHash: string;
		readonly runOpenEnd: number;
		readonly wordPrefix: string;
		readonly properties?: {
			readonly start: number;
			readonly end: number;
			readonly closeStart: number;
			readonly selfClosing: boolean;
			readonly bold?: { readonly start: number; readonly end: number };
			readonly italic?: { readonly start: number; readonly end: number };
		};
	};
}
export interface DocxParagraphSnapshot {
	readonly id: string;
	readonly runs: readonly DocxTextRunSnapshot[];
	readonly editable: boolean;
	readonly blockedReason?: DocxBlockedReason;
	readonly anchor: {
		readonly part: string;
		readonly start: number;
		readonly end: number;
		readonly textHash: string;
		readonly wordPrefix: string;
	};
}
export interface DocxRenderWarning {
	readonly code: string;
	readonly part: string;
	readonly message: string;
}
export interface DocxInspectSnapshot {
	readonly documentId: string;
	readonly revision: number;
	readonly mainPart: string;
	readonly paragraphs: readonly DocxParagraphSnapshot[];
	readonly relatedParts: readonly RelatedPartSnapshot[];
	readonly comments: readonly CommentSnapshot[];
	readonly warnings: readonly DocxRenderWarning[];
	readonly sourceSha256: string;
}
export interface ReplaceTextRunOperation {
	readonly type: "replace_text_run";
	readonly target: { readonly part: "document"; readonly paragraphId: string; readonly runId: string };
	readonly precondition: {
		readonly documentRevision: number;
		readonly expectedText: string;
		readonly expectedTextSha256: string;
	};
	readonly replacement: string;
}
export interface ReplaceTextRangeOperation {
	readonly type: "replace_text_range";
	readonly target: {
		readonly part: "document";
		readonly paragraphId: string;
		readonly start: { readonly runId: string; readonly offset: number };
		readonly end: { readonly runId: string; readonly offset: number };
	};
	readonly precondition: {
		readonly documentRevision: number;
		readonly expectedText: string;
		readonly expectedTextSha256: string;
	};
	readonly replacement: string;
}
export interface InsertParagraphAfterOperation {
	readonly type: "insert_paragraph_after";
	readonly target: { readonly part: "document"; readonly paragraphId: string };
	readonly precondition: {
		readonly documentRevision: number;
		readonly expectedText: string;
		readonly expectedTextSha256: string;
	};
	readonly replacement: string;
}
export interface DeleteParagraphOperation {
	readonly type: "delete_paragraph";
	readonly target: { readonly part: "document"; readonly paragraphId: string };
	readonly precondition: {
		readonly documentRevision: number;
		readonly expectedText: string;
		readonly expectedTextSha256: string;
	};
}
export interface SetTextRunStyleOperation {
	readonly type: "set_text_run_style";
	readonly target: { readonly part: "document"; readonly paragraphId: string; readonly runId: string };
	readonly precondition: {
		readonly documentRevision: number;
		readonly expectedText: string;
		readonly expectedTextSha256: string;
		readonly expectedProperties: { readonly bold: boolean; readonly italic: boolean; readonly styleId?: string };
	};
	readonly replacement: { readonly bold?: boolean; readonly italic?: boolean };
}
export interface ReplaceRelatedTextRunOperation {
	readonly type: "replace_related_text_run";
	readonly target: {
		readonly part: "header" | "footer";
		readonly relatedPartId: string;
		readonly paragraphId: string;
		readonly runId: string;
	};
	readonly precondition: {
		readonly documentRevision: number;
		readonly expectedText: string;
		readonly expectedTextSha256: string;
	};
	readonly replacement: string;
}
export interface ReplaceCommentTextRunOperation {
	readonly type: "replace_comment_text_run";
	readonly target: {
		readonly part: "comments";
		readonly commentId: string;
		readonly paragraphId: string;
		readonly runId: string;
	};
	readonly precondition: {
		readonly documentRevision: number;
		readonly expectedText: string;
		readonly expectedTextSha256: string;
	};
	readonly replacement: string;
}
export type DocumentOperation =
	| ReplaceTextRunOperation
	| ReplaceRelatedTextRunOperation
	| ReplaceCommentTextRunOperation
	| ReplaceTextRangeOperation
	| InsertParagraphAfterOperation
	| DeleteParagraphOperation
	| SetTextRunStyleOperation;
export interface DocumentOperationEnvelope {
	readonly protocolVersion: 1;
	readonly operations: readonly DocumentOperation[];
}
type Patch = {
	readonly part: string;
	readonly start: number;
	readonly end: number;
	readonly preimageSha256: string;
	readonly replacementBase64: string;
	readonly replacementSha256: string;
	readonly kind:
		| "text_run"
		| "related_text_run"
		| "comment_text_run"
		| "text_range"
		| "paragraph_insert"
		| "paragraph_delete"
		| "run_style";
};
export type DocumentSemanticDiff =
	| { readonly runId: string; readonly before: string; readonly after: string }
	| {
			readonly type: "related-text";
			readonly part: "header" | "footer";
			readonly relatedPartId: string;
			readonly runId: string;
			readonly before: string;
			readonly after: string;
	  }
	| {
			readonly type: "comment-text";
			readonly commentId: string;
			readonly runId: string;
			readonly before: string;
			readonly after: string;
	  }
	| {
			readonly type: "run-style";
			readonly runId: string;
			readonly before: { readonly bold: boolean; readonly italic: boolean; readonly styleId?: string };
			readonly after: { readonly bold: boolean; readonly italic: boolean; readonly styleId?: string };
	  }
	| {
			readonly type: "paragraph";
			readonly paragraphId: string;
			readonly change: "insert" | "delete";
			readonly before: string;
			readonly after: string;
	  };
export interface DocumentPlan {
	readonly documentId: string;
	readonly baseRevision: number;
	readonly resultingRevision: number;
	readonly sourceSha256: string;
	readonly envelope: DocumentOperationEnvelope;
	readonly semanticDiff: readonly DocumentSemanticDiff[];
	readonly touchedRuns: readonly string[];
	readonly touchedParagraphs: readonly string[];
	readonly touchedParts: readonly string[];
	readonly patchManifest: readonly Patch[];
	readonly warnings: readonly DocxRenderWarning[];
	readonly expiresAt: number;
	readonly planSha256: string;
}

function scalar(value: string): boolean {
	for (const c of value) {
		const n = c.codePointAt(0)!;
		if (
			!(
				n === 9 ||
				n === 10 ||
				n === 13 ||
				(n >= 32 && n <= 0xd7ff) ||
				(n >= 0xe000 && n <= 0xfffd) ||
				(n >= 0x10000 && n <= 0x10ffff)
			)
		)
			return false;
	}
	return !value.includes("\0");
}
function plain(value: unknown): value is Record<string, unknown> {
	return (
		!!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
	);
}
function canonical(value: unknown, seen = new Set<object>()): string {
	if (
		value === undefined ||
		typeof value === "function" ||
		typeof value === "symbol" ||
		(typeof value === "number" && !Number.isFinite(value))
	)
		throw officeError("VALIDATION_FAILED");
	if (typeof value === "string" || typeof value === "boolean" || value === null || typeof value === "number")
		return JSON.stringify(value);
	if (typeof value !== "object" || seen.has(value)) throw officeError("VALIDATION_FAILED");
	seen.add(value);
	let result: string;
	if (Array.isArray(value)) {
		if (
			Object.keys(value).some((key) => !/^\d+$/.test(key)) ||
			Object.keys(value).length !== value.length ||
			value.some((item) => item === undefined)
		)
			throw officeError("VALIDATION_FAILED");
		result = `[${value.map((item) => canonical(item, seen)).join(",")}]`;
	} else if (plain(value)) {
		result = `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key], seen)}`)
			.join(",")}}`;
	} else throw officeError("VALIDATION_FAILED");
	return result;
}
function clonePlain(value: unknown, seen = new Set<object>()): unknown {
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) throw officeError("VALIDATION_FAILED");
	seen.add(value);
	let result: unknown;
	if (Array.isArray(value)) {
		if (Object.keys(value).some((key) => !/^\d+$/.test(key)) || Object.keys(value).length !== value.length)
			throw officeError("VALIDATION_FAILED");
		result = value.map((item) => clonePlain(item, seen));
	} else if (plain(value)) {
		const output: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) output[key] = clonePlain(item, seen);
		result = output;
	} else throw officeError("VALIDATION_FAILED");
	return result;
}
function immutable<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const item of Array.isArray(value) ? value : Object.values(value as object)) immutable(item);
		Object.freeze(value);
	}
	return value;
}
function escaped(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("\r", "&#xD;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}
function offsets(source: string): number[] {
	const result = new Array<number>(source.length + 1);
	let bytes = 0;
	result[0] = 0;
	for (let index = 0; index < source.length; index += 1) {
		const code = source.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff && index + 1 < source.length) {
			const low = source.charCodeAt(index + 1);
			if (low >= 0xdc00 && low <= 0xdfff) {
				bytes += 4;
				result[index + 1] = bytes - 2;
				result[index + 2] = bytes;
				index += 1;
				continue;
			}
		}
		bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
		result[index + 1] = bytes;
	}
	return result;
}
function utf16IndexForByte(value: string, byteOffset: number): number {
	const map = offsets(value);
	const index = map.indexOf(byteOffset);
	if (index < 0) throw officeError("VALIDATION_FAILED");
	return index;
}
function sourceTagStart(source: string, position: number): number {
	const start = source.lastIndexOf("<", position - 1);
	if (start < 0) throw officeError("XML_INVALID");
	return start;
}
function closingStart(source: string, end: number, name: string): number {
	const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = source.slice(0, end).match(new RegExp(`</${escapedName}\\s*>$`));
	if (match === null) throw officeError("XML_INVALID");
	return end - match[0].length;
}
function attr(tag: SaxesTag, local: string, uri: string): string | undefined {
	const item = Object.values(tag.attributes as Record<string, SaxesAttributeNS>).find(
		(x) => x.local === local && x.uri === uri,
	);
	return item?.value;
}
function onOff(tag: SaxesTag, uri: string): boolean | undefined {
	const value = attr(tag, "val", uri);
	if (value === undefined || value === "") return true;
	const normalized = value.toLowerCase();
	if (["false", "0", "off", "no"].includes(normalized)) return false;
	if (["true", "1", "on", "yes"].includes(normalized)) return true;
	return undefined;
}
function blockedReasonForTag(tag: SaxesTag): DocxBlockedReason | undefined {
	const local = tag.local ?? "";
	if (tag.uri !== WORD_NS && tag.uri !== STRICT_WORD_NS) return "foreign-namespace";
	if (["bookmarkStart", "bookmarkEnd"].includes(local)) return "bookmark-boundary";
	if (["commentRangeStart", "commentRangeEnd", "commentReference"].includes(local)) return "comment-boundary";
	if (["footnoteReference", "endnoteReference"].includes(local)) return "note-reference";
	if (["fldSimple", "fldChar", "instrText"].includes(local)) return "field-boundary";
	if (
		[
			"ins",
			"del",
			"moveFrom",
			"moveTo",
			"moveFromRangeStart",
			"moveFromRangeEnd",
			"moveToRangeStart",
			"moveToRangeEnd",
		].includes(local)
	)
		return "tracked-revision";
	if (local === "sdt") return "content-control";
	if (local === "hyperlink") return "hyperlink-boundary";
	if (["drawing", "pict", "object"].includes(local)) return "drawing-content";
	if (local === "txbxContent") return "textbox-content";
	return undefined;
}

function rewriteTextOpening(raw: string, textStart: number, replacementHasSpace: boolean): string {
	const textIndex = utf16IndexForByte(raw, textStart);
	const openStart = raw.lastIndexOf("<", textIndex);
	const openEnd = raw.indexOf(">", openStart);
	if (openStart < 0 || openEnd < openStart) throw officeError("XML_INVALID");
	const opening = raw.slice(openStart, openEnd + 1);
	const attributes: Array<{ start: number; end: number }> = [];
	let index = 1;
	while (index < opening.length - 1) {
		while (/\s/.test(opening[index] ?? "")) index += 1;
		if (opening[index] === "/" || index >= opening.length - 1) break;
		const nameStart = index;
		while (index < opening.length && !/[\s=/>]/.test(opening[index] ?? "")) index += 1;
		const name = opening.slice(nameStart, index);
		while (/\s/.test(opening[index] ?? "")) index += 1;
		if (opening[index] === ">" || opening[index] === "/") {
			index += 1;
			continue;
		}
		if (opening[index] !== "=") continue;
		index += 1;
		while (/\s/.test(opening[index] ?? "")) index += 1;
		const quote = opening[index];
		if (quote !== '"' && quote !== "'") throw officeError("XML_INVALID");
		index += 1;
		while (index < opening.length && opening[index] !== quote) index += 1;
		if (index >= opening.length) throw officeError("XML_INVALID");
		index += 1;
		if (name === "xml:space") attributes.push({ start: nameStart, end: index });
	}
	let result = opening;
	for (let attribute = attributes.length - 1; attribute >= 0; attribute -= 1) {
		const range = attributes[attribute];
		let start = range.start;
		while (start > 0 && /\s/.test(result[start - 1] ?? "")) start -= 1;
		result = result.slice(0, start) + result.slice(range.end);
	}
	result = result.replace(/\/\s*>$/, ">");
	if (replacementHasSpace) result = result.replace(/>$/, ' xml:space="preserve">');
	const relativeEnd = textIndex === openEnd ? openEnd : textIndex;
	return raw.slice(0, openStart) + result + raw.slice(openEnd + 1, relativeEnd) + raw.slice(relativeEnd);
}

function isTextBoundary(value: string, offset: number): boolean {
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.length) return false;
	if (offset === 0 || offset === value.length) return true;
	const previous = value.charCodeAt(offset - 1);
	const current = value.charCodeAt(offset);
	return !(previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff);
}

function rewriteRunText(
	bytes: Uint8Array,
	run: DocxTextRunSnapshot | RelatedPartRunSnapshot,
	replacementText: string,
): { raw: Uint8Array; replacement: Uint8Array } {
	const raw = bytes.slice(run.anchor.start, run.anchor.end);
	const xml = decoder.decode(raw);
	const textStart = utf16IndexForByte(xml, run.anchor.textStart - run.anchor.start);
	const textEnd = utf16IndexForByte(xml, run.anchor.textEnd - run.anchor.start);
	const selfClosingName = xml.slice(0, textStart).match(/<([^\s/>]+)[^>]*\/\s*>$/)?.[1];
	const close = selfClosingName === undefined ? xml.slice(textEnd) : `</${selfClosingName}>${xml.slice(textEnd)}`;
	const openingBoundary =
		selfClosingName === undefined
			? run.anchor.textStart - run.anchor.start
			: encoder.encode(xml.slice(0, xml.indexOf(`<${selfClosingName}`) + selfClosingName.length + 2)).length;
	const adjusted = rewriteTextOpening(xml, openingBoundary, /^\s|\s$/.test(replacementText));
	const sourceOpenStart =
		selfClosingName === undefined ? xml.lastIndexOf("<", textStart) : xml.indexOf(`<${selfClosingName}`);
	const adjustedOpenEnd = adjusted.indexOf(">", sourceOpenStart);
	if (sourceOpenStart < 0 || adjustedOpenEnd < 0) throw officeError("XML_INVALID");
	return {
		raw,
		replacement: encoder.encode(adjusted.slice(0, adjustedOpenEnd + 1) + escaped(replacementText) + close),
	};
}

function paragraphText(paragraph: DocxParagraphSnapshot): string {
	return paragraph.runs.map((run) => run.text).join("");
}

function createParagraphXml(prefix: string, text: string): Uint8Array {
	const qualified = (local: string): string => (prefix ? `${prefix}:${local}` : local);
	if (text.length === 0) return encoder.encode(`<${qualified("p")}/>`);
	const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : "";
	return encoder.encode(
		`<${qualified("p")}><${qualified("r")}><${qualified("t")}${preserve}>${escaped(text)}</${qualified("t")}></${qualified("r")}></${qualified("p")}>`,
	);
}

function runProperties(run: DocxTextRunSnapshot): { bold: boolean; italic: boolean; styleId?: string } {
	return {
		bold: run.properties.bold ?? false,
		italic: run.properties.italic ?? false,
		...(run.properties.styleId === undefined ? {} : { styleId: run.properties.styleId }),
	};
}

function createRunPropertyXml(prefix: string, local: "b" | "i", value: boolean): string {
	const qualified = prefix ? `${prefix}:${local}` : local;
	const valueName = prefix ? `${prefix}:val` : "val";
	return `<${qualified} ${valueName}="${value ? "1" : "0"}"/>`;
}

function rewriteRunStyle(
	bytes: Uint8Array,
	run: DocxTextRunSnapshot,
	requested: { readonly bold?: boolean; readonly italic?: boolean },
): {
	raw: Uint8Array;
	replacement: Uint8Array;
	before: { bold: boolean; italic: boolean; styleId?: string };
	after: { bold: boolean; italic: boolean; styleId?: string };
	start: number;
	end: number;
} {
	const before = runProperties(run);
	const after = { ...before, ...requested };
	if (before.bold === after.bold && before.italic === after.italic) throw officeError("PRECONDITION_FAILED");
	const changed = (["bold", "italic"] as const).filter((property) => before[property] !== after[property]);
	const properties = run.anchor.properties;
	if (properties === undefined) {
		const qualified = run.anchor.wordPrefix ? `${run.anchor.wordPrefix}:rPr` : "rPr";
		const content = changed
			.map((property) =>
				createRunPropertyXml(run.anchor.wordPrefix, property === "bold" ? "b" : "i", after[property]),
			)
			.join("");
		return {
			raw: new Uint8Array(),
			replacement: encoder.encode(`<${qualified}>${content}</${qualified}>`),
			before,
			after,
			start: run.anchor.runOpenEnd,
			end: run.anchor.runOpenEnd,
		};
	}
	const raw = bytes.slice(properties.start, properties.end);
	const edits: Array<{ start: number; end: number; replacement: Uint8Array }> = [];
	for (const property of changed) {
		const anchor = property === "bold" ? properties.bold : properties.italic;
		const replacement = encoder.encode(
			createRunPropertyXml(run.anchor.wordPrefix, property === "bold" ? "b" : "i", after[property]),
		);
		edits.push({
			start: (anchor?.start ?? properties.closeStart) - properties.start,
			end: (anchor?.end ?? properties.closeStart) - properties.start,
			replacement,
		});
	}
	edits.sort((left, right) => left.start - right.start || left.end - right.end);
	if (properties.selfClosing) {
		const xml = decoder.decode(raw);
		const qualified = run.anchor.wordPrefix ? `${run.anchor.wordPrefix}:rPr` : "rPr";
		const content = edits.map((edit) => decoder.decode(edit.replacement)).join("");
		return {
			raw,
			replacement: encoder.encode(`${xml.replace(/\/\s*>$/, ">")}${content}</${qualified}>`),
			before,
			after,
			start: properties.start,
			end: properties.end,
		};
	}
	let length = raw.length;
	for (const edit of edits) length += edit.replacement.length - (edit.end - edit.start);
	const replacement = new Uint8Array(length);
	let sourceOffset = 0;
	let outputOffset = 0;
	for (const edit of edits) {
		const unchanged = raw.subarray(sourceOffset, edit.start);
		replacement.set(unchanged, outputOffset);
		outputOffset += unchanged.length;
		replacement.set(edit.replacement, outputOffset);
		outputOffset += edit.replacement.length;
		sourceOffset = edit.end;
	}
	replacement.set(raw.subarray(sourceOffset), outputOffset);
	return { raw, replacement, before, after, start: properties.start, end: properties.end };
}

function runSnapshot(
	archive: PackageArchive,
	snapshot: DocxInspectSnapshot,
	input: unknown,
	expiresAt: number,
	now: number,
): DocumentPlan {
	const envelope = validateDocumentOperationEnvelope(input);
	if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt - now > 86_400_000)
		throw officeError("TRANSACTION_EXPIRED");
	const mainBytes = archive.read(snapshot.mainPart);
	const paragraphById = new Map(snapshot.paragraphs.map((paragraph) => [paragraph.id, paragraph]));
	const relatedPartById = new Map(snapshot.relatedParts.map((part) => [part.id, part]));
	const commentById = new Map(snapshot.comments.map((comment) => [comment.id, comment]));
	const runStartById = new Map<string, number>();
	for (const paragraph of snapshot.paragraphs)
		for (const run of paragraph.runs) runStartById.set(run.id, run.anchor.start);
	for (const part of snapshot.relatedParts)
		for (const paragraph of part.paragraphs)
			for (const run of paragraph.runs) runStartById.set(run.id, run.anchor.start);
	for (const comment of snapshot.comments)
		for (const paragraph of comment.paragraphs)
			for (const run of paragraph.runs) runStartById.set(run.id, run.anchor.start);
	const diffs: DocumentSemanticDiff[] = [];
	const patches: Patch[] = [];
	const seen = new Set<string>();
	const touchedParagraphs = new Set<string>();
	const structuralParagraphs = new Set<string>();
	const textParagraphs = new Set<string>();
	let replacementTotal = 0;
	let semanticTotal = 0;
	const addRunPatch = (
		run: DocxTextRunSnapshot | RelatedPartRunSnapshot,
		after: string,
		kind: Patch["kind"],
		diff: DocumentSemanticDiff = { runId: run.id, before: run.text, after },
	): void => {
		if (seen.has(run.id)) throw officeError("PRECONDITION_FAILED");
		if (seen.size >= TRANSACTION_BUDGETS.maxTouchedRuns) throw officeError("VALIDATION_FAILED");
		seen.add(run.id);
		const { raw, replacement } = rewriteRunText(archive.read(run.anchor.part), run, after);
		replacementTotal += replacement.length;
		semanticTotal += encoder.encode(run.text).length + encoder.encode(after).length;
		if (
			replacementTotal > TRANSACTION_BUDGETS.maxDecodedManifestReplacementBytes ||
			replacementTotal > TRANSACTION_BUDGETS.maxPatchReplacementBytes ||
			semanticTotal > TRANSACTION_BUDGETS.maxSemanticDiffBytes
		)
			throw officeError("VALIDATION_FAILED");
		patches.push({
			part: run.anchor.part,
			start: run.anchor.start,
			end: run.anchor.end,
			preimageSha256: sha256(raw),
			replacementBase64: b64(replacement),
			replacementSha256: sha256(replacement),
			kind,
		});
		diffs.push(diff);
	};
	for (const op of envelope.operations) {
		if (op.type === "replace_comment_text_run") {
			const comment = commentById.get(op.target.commentId);
			if (comment === undefined) throw officeError("PRECONDITION_FAILED");
			const paragraph = comment.paragraphs.find((candidate) => candidate.id === op.target.paragraphId);
			const run = paragraph?.runs.find((candidate) => candidate.id === op.target.runId);
			if (paragraph === undefined || run === undefined) throw officeError("PRECONDITION_FAILED");
			if (!run.editable) throw officeError("OPERATION_BLOCKED");
			if (
				op.precondition.documentRevision !== snapshot.revision ||
				run.text !== op.precondition.expectedText ||
				run.anchor.textHash !== op.precondition.expectedTextSha256
			)
				throw officeError("PRECONDITION_FAILED");
			addRunPatch(run, op.replacement, "comment_text_run", {
				type: "comment-text",
				commentId: comment.id,
				runId: run.id,
				before: run.text,
				after: op.replacement,
			});
			continue;
		}
		if (op.type === "replace_related_text_run") {
			const part = relatedPartById.get(op.target.relatedPartId);
			if (part === undefined || part.kind !== op.target.part) throw officeError("PRECONDITION_FAILED");
			const paragraph = part.paragraphs.find((candidate) => candidate.id === op.target.paragraphId);
			if (paragraph === undefined) throw officeError("PRECONDITION_FAILED");
			if (!paragraph.editable) throw officeError("OPERATION_BLOCKED");
			const run = paragraph.runs.find((candidate) => candidate.id === op.target.runId);
			if (run === undefined) throw officeError("PRECONDITION_FAILED");
			if (!run.editable) throw officeError("OPERATION_BLOCKED");
			if (
				op.precondition.documentRevision !== snapshot.revision ||
				run.text !== op.precondition.expectedText ||
				run.anchor.textHash !== op.precondition.expectedTextSha256
			)
				throw officeError("PRECONDITION_FAILED");
			addRunPatch(run, op.replacement, "related_text_run", {
				type: "related-text",
				part: part.kind,
				relatedPartId: part.id,
				runId: run.id,
				before: run.text,
				after: op.replacement,
			});
			continue;
		}
		const paragraph = paragraphById.get(op.target.paragraphId);
		if (paragraph === undefined) throw officeError("PRECONDITION_FAILED");
		if (!paragraph.editable) throw officeError("OPERATION_BLOCKED");
		if (op.precondition.documentRevision !== snapshot.revision) throw officeError("PRECONDITION_FAILED");
		if (op.type === "replace_text_run") {
			if (structuralParagraphs.has(paragraph.id)) throw officeError("PRECONDITION_FAILED");
			textParagraphs.add(paragraph.id);
			const run = paragraph.runs.find((candidate) => candidate.id === op.target.runId);
			if (!run) throw officeError("PRECONDITION_FAILED");
			if (!run.editable) throw officeError("OPERATION_BLOCKED");
			if (run.text !== op.precondition.expectedText || run.anchor.textHash !== op.precondition.expectedTextSha256)
				throw officeError("PRECONDITION_FAILED");
			addRunPatch(run, op.replacement, "text_run");
			continue;
		}
		if (op.type === "set_text_run_style") {
			if (structuralParagraphs.has(paragraph.id)) throw officeError("PRECONDITION_FAILED");
			textParagraphs.add(paragraph.id);
			const run = paragraph.runs.find((candidate) => candidate.id === op.target.runId);
			if (!run) throw officeError("PRECONDITION_FAILED");
			if (!run.editable) throw officeError("OPERATION_BLOCKED");
			if (
				run.text !== op.precondition.expectedText ||
				run.anchor.textHash !== op.precondition.expectedTextSha256 ||
				canonical(runProperties(run)) !== canonical(op.precondition.expectedProperties)
			)
				throw officeError("PRECONDITION_FAILED");
			if (seen.has(run.id)) throw officeError("PRECONDITION_FAILED");
			if (seen.size >= TRANSACTION_BUDGETS.maxTouchedRuns) throw officeError("VALIDATION_FAILED");
			const rewritten = rewriteRunStyle(mainBytes, run, op.replacement);
			seen.add(run.id);
			replacementTotal += rewritten.replacement.length;
			semanticTotal +=
				encoder.encode(canonical(rewritten.before)).length + encoder.encode(canonical(rewritten.after)).length;
			if (
				replacementTotal > TRANSACTION_BUDGETS.maxDecodedManifestReplacementBytes ||
				replacementTotal > TRANSACTION_BUDGETS.maxPatchReplacementBytes ||
				semanticTotal > TRANSACTION_BUDGETS.maxSemanticDiffBytes
			)
				throw officeError("VALIDATION_FAILED");
			patches.push({
				part: run.anchor.part,
				start: rewritten.start,
				end: rewritten.end,
				preimageSha256: sha256(rewritten.raw),
				replacementBase64: b64(rewritten.replacement),
				replacementSha256: sha256(rewritten.replacement),
				kind: "run_style",
			});
			diffs.push({ type: "run-style", runId: run.id, before: rewritten.before, after: rewritten.after });
			continue;
		}
		if (op.type === "insert_paragraph_after" || op.type === "delete_paragraph") {
			if (structuralParagraphs.has(paragraph.id) || textParagraphs.has(paragraph.id))
				throw officeError("PRECONDITION_FAILED");
			const before = paragraphText(paragraph);
			if (
				before !== op.precondition.expectedText ||
				paragraph.anchor.textHash !== op.precondition.expectedTextSha256
			)
				throw officeError("PRECONDITION_FAILED");
			const insertion = op.type === "insert_paragraph_after";
			if (!insertion && seen.size + paragraph.runs.length > TRANSACTION_BUDGETS.maxTouchedRuns)
				throw officeError("VALIDATION_FAILED");
			structuralParagraphs.add(paragraph.id);
			touchedParagraphs.add(paragraph.id);
			if (!insertion) for (const run of paragraph.runs) seen.add(run.id);
			const raw = insertion ? new Uint8Array() : mainBytes.slice(paragraph.anchor.start, paragraph.anchor.end);
			const replacement = insertion
				? createParagraphXml(paragraph.anchor.wordPrefix, op.replacement)
				: new Uint8Array();
			replacementTotal += replacement.length;
			semanticTotal += encoder.encode(before).length + (insertion ? encoder.encode(op.replacement).length : 0);
			if (
				replacementTotal > TRANSACTION_BUDGETS.maxDecodedManifestReplacementBytes ||
				replacementTotal > TRANSACTION_BUDGETS.maxPatchReplacementBytes ||
				semanticTotal > TRANSACTION_BUDGETS.maxSemanticDiffBytes
			)
				throw officeError("VALIDATION_FAILED");
			patches.push({
				part: paragraph.anchor.part,
				start: insertion ? paragraph.anchor.end : paragraph.anchor.start,
				end: paragraph.anchor.end,
				preimageSha256: sha256(raw),
				replacementBase64: b64(replacement),
				replacementSha256: sha256(replacement),
				kind: insertion ? "paragraph_insert" : "paragraph_delete",
			});
			diffs.push({
				type: "paragraph",
				paragraphId: paragraph.id,
				change: insertion ? "insert" : "delete",
				before: insertion ? "" : before,
				after: insertion ? op.replacement : "",
			});
			continue;
		}
		if (structuralParagraphs.has(paragraph.id)) throw officeError("PRECONDITION_FAILED");
		textParagraphs.add(paragraph.id);
		const startIndex = paragraph.runs.findIndex((run) => run.id === op.target.start.runId);
		const endIndex = paragraph.runs.findIndex((run) => run.id === op.target.end.runId);
		if (startIndex < 0 || endIndex <= startIndex) throw officeError("PRECONDITION_FAILED");
		const selectedRunCount = endIndex - startIndex + 1;
		if (selectedRunCount > TRANSACTION_BUDGETS.maxTouchedRuns - seen.size) throw officeError("VALIDATION_FAILED");
		const selectedRuns = paragraph.runs.slice(startIndex, endIndex + 1);
		const startRun = selectedRuns[0];
		const endRun = selectedRuns.at(-1)!;
		if (selectedRuns.some((run) => !run.editable)) throw officeError("OPERATION_BLOCKED");
		if (
			!isTextBoundary(startRun.text, op.target.start.offset) ||
			!isTextBoundary(endRun.text, op.target.end.offset) ||
			op.target.start.offset >= startRun.text.length ||
			op.target.end.offset <= 0
		)
			throw officeError("PRECONDITION_FAILED");
		const expectedText = selectedRuns
			.map((run, index) => {
				if (index === 0) return run.text.slice(op.target.start.offset);
				if (index === selectedRuns.length - 1) return run.text.slice(0, op.target.end.offset);
				return run.text;
			})
			.join("");
		if (
			expectedText !== op.precondition.expectedText ||
			sha256(encoder.encode(expectedText)) !== op.precondition.expectedTextSha256
		)
			throw officeError("PRECONDITION_FAILED");
		for (let index = 0; index < selectedRuns.length; index += 1) {
			const run = selectedRuns[index];
			const after =
				index === 0
					? run.text.slice(0, op.target.start.offset) + op.replacement
					: index === selectedRuns.length - 1
						? run.text.slice(op.target.end.offset)
						: "";
			addRunPatch(run, after, "text_range");
		}
	}
	patches.sort(
		(left, right) => left.part.localeCompare(right.part) || left.start - right.start || left.end - right.end,
	);
	diffs.sort((left, right) => {
		const leftStart =
			"paragraphId" in left && left.type === "paragraph"
				? paragraphById.get(left.paragraphId)?.anchor.start
				: runStartById.get(left.runId);
		const rightStart =
			"paragraphId" in right && right.type === "paragraph"
				? paragraphById.get(right.paragraphId)?.anchor.start
				: runStartById.get(right.runId);
		return (leftStart ?? Number.MAX_SAFE_INTEGER) - (rightStart ?? Number.MAX_SAFE_INTEGER);
	});
	const orderedRuns = [...seen].sort(
		(left, right) =>
			(runStartById.get(left) ?? Number.MAX_SAFE_INTEGER) - (runStartById.get(right) ?? Number.MAX_SAFE_INTEGER),
	);
	const body = {
		documentId: snapshot.documentId,
		baseRevision: snapshot.revision,
		resultingRevision: snapshot.revision + 1,
		sourceSha256: sha256(archive.serialize()),
		envelope,
		semanticDiff: diffs,
		touchedRuns: orderedRuns,
		touchedParagraphs: [...touchedParagraphs].sort(
			(left, right) =>
				(paragraphById.get(left)?.anchor.start ?? Number.MAX_SAFE_INTEGER) -
				(paragraphById.get(right)?.anchor.start ?? Number.MAX_SAFE_INTEGER),
		),
		touchedParts: [...new Set(patches.map((patch) => patch.part))].sort(),
		patchManifest: patches,
		warnings: snapshot.warnings,
		expiresAt,
	};
	const bodyCanonicalBytes = encoder.encode(canonical(body));
	if (bodyCanonicalBytes.length > TRANSACTION_BUDGETS.maxPlanBytes) throw officeError("VALIDATION_FAILED");
	const plan = { ...body, planSha256: sha256(bodyCanonicalBytes) };
	if (encoder.encode(canonical(plan)).length > TRANSACTION_BUDGETS.maxPlanBytes)
		throw officeError("VALIDATION_FAILED");
	return immutable(plan);
}
export function inspectDocx(archive: PackageArchive, documentId: string, revision = 1): DocxInspectSnapshot {
	if (!documentId || encoder.encode(documentId).length > 256 || !Number.isSafeInteger(revision) || revision < 1)
		throw officeError("VALIDATION_FAILED");
	const resolution = resolveDocx(archive),
		main = resolution.mainPart.path,
		mainEntry = archive.entries().find((entry) => entry.path === main);
	if (mainEntry === undefined) throw officeError("DOCX_MAIN_PART_MISSING");
	if (mainEntry.uncompressedSize > TRANSACTION_BUDGETS.maxXmlBytes) throw officeError("XML_TOO_LARGE");
	const bytes = archive.read(main);
	let xml: string;
	try {
		xml = decoder.decode(bytes);
	} catch {
		throw officeError("XML_INVALID");
	}
	const map = offsets(xml),
		parser = new SaxesParser({ xmlns: true, position: true, fragment: false });
	type Node = {
		tag: SaxesTag;
		parent: Node | undefined;
		start: number;
		openEnd: number;
		closeStart: number;
		end: number;
		text: string;
		textStart: number;
		textEnd: number;
		children: Node[];
		blocked: DocxBlockedReason | undefined;
	};
	const stack: Node[] = [];
	const paragraphs: Node[] = [];
	const warnings: DocxRenderWarning[] = resolution.warnings.map((warning) => ({ ...warning }));
	let root: Node | undefined,
		nodes = 0,
		failure: Error | undefined,
		pendingStart = 0;
	const abort = (error: Error): never => {
		failure = error;
		throw error;
	};
	parser.on("error", (error: Error) => {
		failure = error;
	});
	parser.on("doctype", () => abort(officeError("XML_DTD_FORBIDDEN")));
	parser.on("xmldecl", () => {
		// saxes only emits xmldecl in the XML declaration state; later <?xml?> is a PI.
	});
	parser.on("processinginstruction", (instruction) => {
		if (instruction.target.toLowerCase() !== "xml") abort(officeError("XML_PI_FORBIDDEN"));
	});
	parser.on("opentagstart", () => {
		if (++nodes > TRANSACTION_BUDGETS.maxXmlNodes || stack.length >= TRANSACTION_BUDGETS.maxXmlDepth)
			abort(officeError("XML_INVALID"));
		pendingStart = map[sourceTagStart(xml, parser.position)];
	});
	parser.on("opentag", (tag: SaxesTag) => {
		const node: Node = {
			tag: { ...tag, attributes: { ...tag.attributes } },
			parent: stack.at(-1),
			start: pendingStart,
			openEnd: map[parser.position],
			closeStart: map[parser.position],
			end: map[parser.position],
			text: "",
			textStart: map[parser.position],
			textEnd: map[parser.position],
			children: [],
			blocked: undefined,
		};
		if (stack.length) {
			const parent = stack.at(-1)!;
			parent.children.push(node);
			if (parent.blocked !== undefined) node.blocked = parent.blocked;
		} else if (root) abort(new Error("multiple roots"));
		else root = node;
		stack.push(node);
		const ownBlockedReason = blockedReasonForTag(tag);
		if (ownBlockedReason !== undefined && stack.some((x) => x.tag.local === "body"))
			node.blocked = node.blocked ?? ownBlockedReason;
	});
	parser.on("text", (text: string) => {
		const node = stack.at(-1);
		if (!node) {
			if (text.trim()) failure = new Error("text outside root");
			return;
		}
		if (!node.text) node.textStart = node.openEnd;
		node.text += text;
	});
	parser.on("cdata", () => {
		if (stack.length === 0) abort(officeError("XML_INVALID"));
		for (const node of stack) node.blocked = node.blocked ?? "xml-cdata";
	});
	parser.on("comment", () => {
		if (stack.length === 0) abort(officeError("XML_INVALID"));
		for (const node of stack) node.blocked = node.blocked ?? "xml-comment";
	});
	parser.on("processinginstruction", (instruction) => {
		if (instruction.target.toLowerCase() !== "xml") abort(officeError("XML_PI_FORBIDDEN"));
	});
	parser.on("closetag", (tag: SaxesTag) => {
		const node = stack.pop();
		if (!node) return;
		node.tag = { ...tag, attributes: { ...tag.attributes } };
		node.closeStart = tag.isSelfClosing ? node.openEnd : map[closingStart(xml, parser.position, tag.name)];
		node.end = map[parser.position];
		if (node.tag.local === "t") {
			if (node.tag.isSelfClosing) node.textEnd = node.openEnd;
			else node.textEnd = map[closingStart(xml, parser.position, tag.name)];
		}
		if (
			node.tag.local === "p" &&
			(node.tag.uri === WORD_NS || node.tag.uri === STRICT_WORD_NS) &&
			stack.some(
				(ancestor) =>
					ancestor.tag.local === "body" && (ancestor.tag.uri === WORD_NS || ancestor.tag.uri === STRICT_WORD_NS),
			)
		)
			paragraphs.push(node);
		if (tag.local === "body") void node;
	});
	parser.write(xml).close();
	if (failure || stack.length || !root) throw officeError("XML_INVALID");
	const isWordNode = (node: Node, local: string): boolean =>
		node.tag.local === local && (node.tag.uri === WORD_NS || node.tag.uri === STRICT_WORD_NS);
	const body = root.children.filter((node) => isWordNode(node, "body"));
	const hasValidDocumentChildren =
		(root.children.length === 1 && root.children[0] === body[0]) ||
		(root.children.length === 2 && isWordNode(root.children[0], "background") && root.children[1] === body[0]);
	if (
		root.tag.local !== "document" ||
		(root.tag.uri !== WORD_NS && root.tag.uri !== STRICT_WORD_NS) ||
		body.length !== 1 ||
		!hasValidDocumentChildren
	)
		throw officeError("XML_INVALID");
	const ps = paragraphs;
	const firstBlockedReason = (node: Node): DocxBlockedReason | undefined =>
		node.blocked ?? node.children.map(firstBlockedReason).find((reason) => reason !== undefined);
	const result = ps.map((p, pi) => {
		const directRuns = p.children.filter((n) => n.tag.local === "r" && n.tag.uri === p.tag.uri);
		const paragraphBoundary = p.children.find(
			(n) => n.tag.local !== "pPr" && (n.tag.local !== "r" || n.tag.uri !== p.tag.uri),
		);
		const nestedParagraphReason =
			p.parent?.tag.local === "body" && (p.parent.tag.uri === WORD_NS || p.parent.tag.uri === STRICT_WORD_NS)
				? undefined
				: "unsupported-paragraph-boundary";
		const paragraphBlockedReason =
			p.blocked ??
			nestedParagraphReason ??
			(paragraphBoundary === undefined
				? undefined
				: (firstBlockedReason(paragraphBoundary) ??
					blockedReasonForTag(paragraphBoundary.tag) ??
					"unsupported-paragraph-boundary"));
		const runs = directRuns.map((r, ri) => {
			const ts = r.children.filter((n) => n.tag.local === "t" && n.tag.uri === r.tag.uri);
			const unsupportedChild = r.children.find((n) => n.tag.local !== "rPr" && n.tag.local !== "t");
			const descendantReason = firstBlockedReason(r);
			const structuralReason =
				descendantReason ??
				(unsupportedChild === undefined
					? ts.length === 1 && ts[0].children.length === 0
						? undefined
						: "complex-run"
					: (blockedReasonForTag(unsupportedChild.tag) ?? "complex-run"));
			const text = ts[0]?.text ?? "";
			const propertyNodes = r.children.filter((n) => n.tag.local === "rPr" && n.tag.uri === r.tag.uri);
			const properties = propertyNodes[0];
			const boldNodes = properties?.children.filter((x) => x.tag.local === "b" && x.tag.uri === r.tag.uri) ?? [];
			const italicNodes = properties?.children.filter((x) => x.tag.local === "i" && x.tag.uri === r.tag.uri) ?? [];
			const boldNode = boldNodes[0];
			const italicNode = italicNodes[0];
			const validOnOffAttributes = (node: Node | undefined): boolean => {
				if (node === undefined) return true;
				const attributes = Object.values(node.tag.attributes as Record<string, SaxesAttributeNS>);
				return (
					attributes.length <= 1 &&
					attributes.every((attribute) => attribute.local === "val" && attribute.uri === r.tag.uri)
				);
			};
			const boldValue = boldNode === undefined ? false : onOff(boldNode.tag, r.tag.uri ?? "");
			const italicValue = italicNode === undefined ? false : onOff(italicNode.tag, r.tag.uri ?? "");
			const bold = boldValue ?? false;
			const italic = italicValue ?? false;
			const runBlockedReason =
				structuralReason ??
				(propertyNodes.length > 1 ||
				boldNodes.length > 1 ||
				italicNodes.length > 1 ||
				!validOnOffAttributes(boldNode) ||
				!validOnOffAttributes(italicNode)
					? "invalid-run-property"
					: undefined) ??
				(boldValue === undefined || italicValue === undefined ? "invalid-run-property" : undefined) ??
				paragraphBlockedReason;
			const editable = runBlockedReason === undefined;
			const id = `r-${pi}-${ri}`;
			return {
				id,
				text,
				properties: {
					bold,
					italic,
					styleId: (() => {
						const style = properties?.children.find((n) => n.tag.local === "rStyle" && n.tag.uri === r.tag.uri);
						return style === undefined ? undefined : attr(style.tag, "val", r.tag.uri ?? "");
					})(),
				},
				editable,
				blockedReason: runBlockedReason,
				anchor: {
					part: main,
					start: r.start,
					end: r.end,
					textStart: ts[0]?.textStart ?? r.openEnd,
					textEnd: ts[0]?.textEnd ?? r.openEnd,
					textHash: sha256(encoder.encode(text)),
					runOpenEnd: r.openEnd,
					wordPrefix: r.tag.prefix ?? "",
					properties:
						properties === undefined
							? undefined
							: {
									start: properties.start,
									end: properties.end,
									closeStart: properties.closeStart,
									selfClosing: properties.tag.isSelfClosing,
									bold: boldNode === undefined ? undefined : { start: boldNode.start, end: boldNode.end },
									italic:
										italicNode === undefined ? undefined : { start: italicNode.start, end: italicNode.end },
								},
				},
			};
		});
		const paragraphReason = paragraphBlockedReason ?? runs.find((run) => !run.editable)?.blockedReason;
		const isBlocked = paragraphReason !== undefined;
		if (isBlocked && !warnings.some((warning) => warning.code === "BLOCKED_CONTENT" && warning.part === main))
			warnings.push({ code: "BLOCKED_CONTENT", part: main, message: `paragraph p-${pi} contains blocked content` });
		return {
			id: `p-${pi}`,
			runs,
			editable: !isBlocked,
			blockedReason: paragraphReason,
			anchor: {
				part: main,
				start: p.start,
				end: p.end,
				textHash: sha256(encoder.encode(runs.map((run) => run.text).join(""))),
				wordPrefix: p.tag.prefix ?? "",
			},
		};
	});
	const relatedParts = resolution.relatedParts
		.filter(
			(part): part is typeof part & { readonly kind: "header" | "footer" } =>
				part.kind === "header" || part.kind === "footer",
		)
		.map((part) =>
			inspectRelatedWordPart(archive.read(part.path), part, {
				maxXmlBytes: TRANSACTION_BUDGETS.maxXmlBytes,
				maxXmlDepth: TRANSACTION_BUDGETS.maxXmlDepth,
				maxXmlNodes: TRANSACTION_BUDGETS.maxXmlNodes,
			}),
		);
	for (const part of relatedParts) {
		if (part.blocked)
			warnings.push({ code: "BLOCKED_CONTENT", part: part.path, message: `${part.kind} contains blocked content` });
	}
	const comments = resolution.relatedParts
		.filter((part) => part.kind === "comments")
		.flatMap(
			(part) =>
				inspectCommentsWordPart(archive.read(part.path), part, {
					maxXmlBytes: TRANSACTION_BUDGETS.maxXmlBytes,
					maxXmlDepth: TRANSACTION_BUDGETS.maxXmlDepth,
					maxXmlNodes: TRANSACTION_BUDGETS.maxXmlNodes,
				}).comments,
		);
	for (const comment of comments) {
		if (
			comment.blocked &&
			!warnings.some((warning) => warning.code === "BLOCKED_CONTENT" && warning.part === comment.path)
		)
			warnings.push({
				code: "BLOCKED_CONTENT",
				part: comment.path,
				message: `comment ${comment.commentId} contains blocked content`,
			});
	}
	return immutable({
		documentId,
		revision,
		mainPart: main,
		paragraphs: result,
		relatedParts,
		comments,
		warnings,
		sourceSha256: sha256(archive.serialize()),
	});
}
export function validateDocumentOperationEnvelope(value: unknown): DocumentOperationEnvelope {
	if (
		!plain(value) ||
		value.protocolVersion !== 1 ||
		!Array.isArray(value.operations) ||
		Object.keys(value).length !== 2 ||
		value.operations.length > TRANSACTION_BUDGETS.maxOperations
	)
		throw officeError("VALIDATION_FAILED");
	if (encoder.encode(canonical(value)).length > TRANSACTION_BUDGETS.maxEnvelopeBytes)
		throw officeError("VALIDATION_FAILED");
	let expectedBytes = 0;
	let replacementBytes = 0;
	const validId = (id: unknown): id is string =>
		typeof id === "string" &&
		id.length > 0 &&
		encoder.encode(id).length <= TRANSACTION_BUDGETS.maxIdBytes &&
		scalar(id);
	for (const operation of value.operations) {
		if (!plain(operation)) throw officeError("VALIDATION_FAILED");
		if (operation.type === "replace_related_text_run" || operation.type === "replace_comment_text_run") {
			const { precondition, replacement, target } = operation;
			const commentOperation = operation.type === "replace_comment_text_run";
			if (
				Object.keys(operation).length !== 4 ||
				!plain(target) ||
				Object.keys(target).length !== 4 ||
				(commentOperation ? target.part !== "comments" : target.part !== "header" && target.part !== "footer") ||
				(commentOperation ? !validId(target.commentId) : !validId(target.relatedPartId)) ||
				!validId(target.paragraphId) ||
				!validId(target.runId) ||
				!plain(precondition) ||
				Object.keys(precondition).length !== 3 ||
				!Number.isSafeInteger(precondition.documentRevision) ||
				typeof precondition.expectedText !== "string" ||
				!scalar(precondition.expectedText) ||
				encoder.encode(precondition.expectedText).length > TRANSACTION_BUDGETS.maxExpectedTextBytes ||
				typeof precondition.expectedTextSha256 !== "string" ||
				precondition.expectedTextSha256 !== sha256(encoder.encode(precondition.expectedText)) ||
				typeof replacement !== "string" ||
				!scalar(replacement) ||
				encoder.encode(replacement).length > TRANSACTION_BUDGETS.maxReplacementBytes
			)
				throw officeError("VALIDATION_FAILED");
			expectedBytes += encoder.encode(precondition.expectedText).length;
			replacementBytes += encoder.encode(replacement).length;
			if (
				expectedBytes > TRANSACTION_BUDGETS.maxOperationsExpectedBytes ||
				replacementBytes > TRANSACTION_BUDGETS.maxOperationsReplacementBytes
			)
				throw officeError("VALIDATION_FAILED");
			continue;
		}
		if (operation.type === "set_text_run_style") {
			const { precondition, replacement, target } = operation;
			if (
				Object.keys(operation).length !== 4 ||
				!plain(target) ||
				Object.keys(target).length !== 3 ||
				target.part !== "document" ||
				!validId(target.paragraphId) ||
				!validId(target.runId) ||
				!plain(precondition) ||
				Object.keys(precondition).length !== 4 ||
				!Number.isSafeInteger(precondition.documentRevision) ||
				typeof precondition.expectedText !== "string" ||
				!scalar(precondition.expectedText) ||
				encoder.encode(precondition.expectedText).length > TRANSACTION_BUDGETS.maxExpectedTextBytes ||
				typeof precondition.expectedTextSha256 !== "string" ||
				precondition.expectedTextSha256 !== sha256(encoder.encode(precondition.expectedText)) ||
				!plain(precondition.expectedProperties) ||
				(Object.keys(precondition.expectedProperties).length !== 2 &&
					Object.keys(precondition.expectedProperties).length !== 3) ||
				Object.keys(precondition.expectedProperties).some(
					(key) => key !== "bold" && key !== "italic" && key !== "styleId",
				) ||
				typeof precondition.expectedProperties.bold !== "boolean" ||
				typeof precondition.expectedProperties.italic !== "boolean" ||
				(precondition.expectedProperties.styleId !== undefined &&
					!validId(precondition.expectedProperties.styleId)) ||
				!plain(replacement) ||
				Object.keys(replacement).length < 1 ||
				Object.keys(replacement).length > 2 ||
				Object.keys(replacement).some((key) => key !== "bold" && key !== "italic") ||
				(replacement.bold !== undefined && typeof replacement.bold !== "boolean") ||
				(replacement.italic !== undefined && typeof replacement.italic !== "boolean")
			)
				throw officeError("VALIDATION_FAILED");
			const expectedLength = encoder.encode(precondition.expectedText).length;
			const replacementLength = encoder.encode(canonical(replacement)).length;
			expectedBytes += expectedLength;
			replacementBytes += replacementLength;
			if (
				expectedBytes > TRANSACTION_BUDGETS.maxOperationsExpectedBytes ||
				replacementBytes > TRANSACTION_BUDGETS.maxOperationsReplacementBytes
			)
				throw officeError("VALIDATION_FAILED");
			continue;
		}
		const { precondition, replacement, target, type } = operation;
		const hasReplacement = type !== "delete_paragraph";
		if (
			(type !== "replace_text_run" &&
				type !== "replace_text_range" &&
				type !== "insert_paragraph_after" &&
				type !== "delete_paragraph") ||
			Object.keys(operation).length !== (hasReplacement ? 4 : 3) ||
			!plain(target) ||
			!plain(precondition) ||
			Object.keys(precondition).length !== 3 ||
			target.part !== "document" ||
			!validId(target.paragraphId) ||
			(hasReplacement &&
				(typeof replacement !== "string" ||
					!scalar(replacement) ||
					encoder.encode(replacement).length > TRANSACTION_BUDGETS.maxReplacementBytes)) ||
			(!hasReplacement && replacement !== undefined) ||
			typeof precondition.documentRevision !== "number" ||
			!Number.isSafeInteger(precondition.documentRevision) ||
			typeof precondition.expectedText !== "string" ||
			!scalar(precondition.expectedText) ||
			encoder.encode(precondition.expectedText).length > TRANSACTION_BUDGETS.maxExpectedTextBytes ||
			typeof precondition.expectedTextSha256 !== "string" ||
			precondition.expectedTextSha256 !== sha256(encoder.encode(precondition.expectedText)) ||
			!/^[0-9a-f]{64}$/.test(precondition.expectedTextSha256)
		)
			throw officeError("VALIDATION_FAILED");
		if (type === "replace_text_run") {
			if (Object.keys(target).length !== 3 || !validId(target.runId)) throw officeError("VALIDATION_FAILED");
		} else if (type === "replace_text_range") {
			if (
				Object.keys(target).length !== 4 ||
				!plain(target.start) ||
				!plain(target.end) ||
				Object.keys(target.start).length !== 2 ||
				Object.keys(target.end).length !== 2 ||
				!validId(target.start.runId) ||
				!validId(target.end.runId) ||
				!Number.isSafeInteger(target.start.offset) ||
				!Number.isSafeInteger(target.end.offset) ||
				(target.start.offset as number) < 0 ||
				(target.end.offset as number) < 0
			)
				throw officeError("VALIDATION_FAILED");
		} else if (Object.keys(target).length !== 2) throw officeError("VALIDATION_FAILED");
		const replacementLength = hasReplacement ? encoder.encode(replacement as string).length : 0;
		const expectedLength = encoder.encode(precondition.expectedText).length;
		if (
			expectedLength + replacementLength >
			TRANSACTION_BUDGETS.maxExpectedTextBytes + TRANSACTION_BUDGETS.maxReplacementBytes
		)
			throw officeError("VALIDATION_FAILED");
		expectedBytes += expectedLength;
		replacementBytes += replacementLength;
		if (
			expectedBytes > TRANSACTION_BUDGETS.maxOperationsExpectedBytes ||
			replacementBytes > TRANSACTION_BUDGETS.maxOperationsReplacementBytes
		)
			throw officeError("VALIDATION_FAILED");
	}
	const cloned = clonePlain(value) as DocumentOperationEnvelope;
	if (encoder.encode(canonical(cloned)).length > TRANSACTION_BUDGETS.maxEnvelopeBytes)
		throw officeError("VALIDATION_FAILED");
	return immutable(cloned);
}
export function planDocx(
	archive: PackageArchive,
	snapshot: DocxInspectSnapshot,
	input: unknown,
	expiresAt: number,
	now = Date.now(),
): DocumentPlan {
	return runSnapshot(archive, snapshot, input, expiresAt, now);
}
type ValidatedPatch = { readonly patch: Patch; readonly replacement: Uint8Array };
function validatePatches(patches: readonly Patch[], length: number, part: string): readonly ValidatedPatch[] {
	let previousEnd = 0;
	let replacementTotal = 0;
	const validated: ValidatedPatch[] = [];
	if (patches.length > TRANSACTION_BUDGETS.maxTouchedRuns) throw officeError("VALIDATION_FAILED");
	for (const patch of patches) {
		const zeroWidth = patch.kind === "paragraph_insert" || (patch.kind === "run_style" && patch.start === patch.end);
		if (
			patch.part !== part ||
			!Number.isSafeInteger(patch.start) ||
			!Number.isSafeInteger(patch.end) ||
			patch.start < previousEnd ||
			(zeroWidth ? patch.end !== patch.start : patch.end <= patch.start) ||
			patch.end > length ||
			(patch.kind !== "text_run" &&
				patch.kind !== "related_text_run" &&
				patch.kind !== "comment_text_run" &&
				patch.kind !== "text_range" &&
				patch.kind !== "paragraph_insert" &&
				patch.kind !== "paragraph_delete" &&
				patch.kind !== "run_style") ||
			!/^[0-9a-f]{64}$/.test(patch.preimageSha256) ||
			!/^[0-9a-f]{64}$/.test(patch.replacementSha256)
		)
			throw officeError("VALIDATION_FAILED");
		let replacement: Uint8Array;
		try {
			replacement = fromB64(patch.replacementBase64);
		} catch {
			throw officeError("VALIDATION_FAILED");
		}
		if (sha256(replacement) !== patch.replacementSha256 || b64(replacement) !== patch.replacementBase64)
			throw officeError("VALIDATION_FAILED");
		replacementTotal += replacement.length;
		if (replacementTotal > TRANSACTION_BUDGETS.maxPatchReplacementBytes) throw officeError("VALIDATION_FAILED");
		validated.push({ patch, replacement });
		previousEnd = patch.end;
	}
	return validated;
}
export function commitDocx(
	archive: PackageArchive,
	snapshot: DocxInspectSnapshot,
	plan: DocumentPlan,
	now = Date.now(),
): Uint8Array {
	if (!Number.isSafeInteger(plan.expiresAt) || plan.expiresAt <= now) throw officeError("TRANSACTION_EXPIRED");
	if (typeof plan.documentId !== "string" || typeof plan.baseRevision !== "number")
		throw officeError("STALE_DOCUMENT");
	const current = inspectDocx(archive, plan.documentId, plan.baseRevision);
	if (current.mainPart !== snapshot.mainPart || current.revision !== snapshot.revision)
		throw officeError("STALE_DOCUMENT");
	const expected = planDocx(archive, current, plan.envelope, plan.expiresAt, now);
	let actualCanonical: string;
	let expectedCanonical: string;
	try {
		actualCanonical = canonical(plan);
		expectedCanonical = canonical(expected);
	} catch {
		throw officeError("VALIDATION_FAILED");
	}
	if (actualCanonical !== expectedCanonical) throw officeError("VALIDATION_FAILED");
	if (plan.patchManifest.length === 0) return archive.serialize();
	let output = archive.serialize();
	for (const part of plan.touchedParts) {
		const currentArchive = PackageArchive.open(output);
		const source = currentArchive.read(part);
		const validatedPatches = validatePatches(
			plan.patchManifest.filter((patch) => patch.part === part),
			source.length,
			part,
		);
		if (validatedPatches.length === 0) throw officeError("VALIDATION_FAILED");
		let contentLength = source.length;
		for (const { patch, replacement } of validatedPatches) {
			if (sha256(source.subarray(patch.start, patch.end)) !== patch.preimageSha256)
				throw officeError("PRECONDITION_FAILED");
			contentLength += replacement.length - (patch.end - patch.start);
		}
		if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > TRANSACTION_BUDGETS.maxXmlBytes)
			throw officeError("VALIDATION_FAILED");
		const content = new Uint8Array(contentLength);
		let sourceOffset = 0;
		let outputOffset = 0;
		for (const { patch, replacement } of validatedPatches) {
			const unchanged = source.subarray(sourceOffset, patch.start);
			content.set(unchanged, outputOffset);
			outputOffset += unchanged.length;
			content.set(replacement, outputOffset);
			outputOffset += replacement.length;
			sourceOffset = patch.end;
		}
		content.set(source.subarray(sourceOffset), outputOffset);
		const next = currentArchive.replace(part, content);
		const delta = verifyReplacement(output, next, part, content);
		if (
			delta.changedEntries.length !== 1 ||
			delta.changedEntries[0] !== part ||
			delta.unchangedEntries.length !== currentArchive.entries().length - 1
		)
			throw officeError("ARCHIVE_INVALID");
		output = next;
	}
	const reopened = PackageArchive.open(output);
	const checked = inspectDocx(reopened, current.documentId, plan.resultingRevision);
	const checkedRuns = new Map<string, DocxTextRunSnapshot | RelatedPartRunSnapshot>();
	for (const paragraph of checked.paragraphs) for (const run of paragraph.runs) checkedRuns.set(run.id, run);
	for (const part of checked.relatedParts)
		for (const paragraph of part.paragraphs) for (const run of paragraph.runs) checkedRuns.set(run.id, run);
	for (const comment of checked.comments)
		for (const paragraph of comment.paragraphs) for (const run of paragraph.runs) checkedRuns.set(run.id, run);
	for (const diff of plan.semanticDiff) {
		if ("type" in diff && diff.type === "paragraph") continue;
		const found = checkedRuns.get(diff.runId);
		if (!found) throw officeError("PRECONDITION_FAILED");
		if ("type" in diff && diff.type === "run-style") {
			if (!("properties" in found) || canonical(runProperties(found)) !== canonical(diff.after))
				throw officeError("PRECONDITION_FAILED");
		} else if (found.text !== diff.after) throw officeError("PRECONDITION_FAILED");
	}
	return output;
}
