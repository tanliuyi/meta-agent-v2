import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { type SaxesAttributeNS, SaxesParser, type SaxesTag } from "saxes";
import { PackageArchive, verifyReplacement } from "./archive.ts";
import { resolveDocx } from "./docx.ts";
import { officeError } from "./errors.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export const TRANSACTION_BUDGETS = Object.freeze({
	maxEnvelopeBytes: 1_048_576,
	maxOperations: 100,
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
	};
}
export interface DocxParagraphSnapshot {
	readonly id: string;
	readonly runs: readonly DocxTextRunSnapshot[];
	readonly editable: boolean;
	readonly blockedReason?: DocxBlockedReason;
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
export type DocumentOperation = ReplaceTextRunOperation;
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
	readonly kind: "text_run";
};
export interface DocumentPlan {
	readonly documentId: string;
	readonly baseRevision: number;
	readonly resultingRevision: number;
	readonly sourceSha256: string;
	readonly envelope: DocumentOperationEnvelope;
	readonly semanticDiff: readonly { readonly runId: string; readonly before: string; readonly after: string }[];
	readonly touchedRuns: readonly string[];
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
	const bytes = archive.read(snapshot.mainPart),
		diffs: { runId: string; before: string; after: string }[] = [],
		patches: Patch[] = [],
		seen = new Set<string>();
	let replacementTotal = 0;
	let semanticTotal = 0;
	for (const op of envelope.operations) {
		const paragraph = snapshot.paragraphs.find((p) => p.id === op.target.paragraphId),
			run = paragraph?.runs.find((r) => r.id === op.target.runId);
		if (paragraph !== undefined && (!paragraph.editable || (run !== undefined && !run.editable)))
			throw officeError("OPERATION_BLOCKED");
		if (
			!run ||
			op.precondition.documentRevision !== snapshot.revision ||
			run.text !== op.precondition.expectedText ||
			run.anchor.textHash !== op.precondition.expectedTextSha256 ||
			op.precondition.expectedText !== run.text ||
			seen.has(run.id)
		)
			throw officeError("PRECONDITION_FAILED");
		seen.add(run.id);
		const raw = bytes.slice(run.anchor.start, run.anchor.end),
			xml = decoder.decode(raw);
		const textStart = utf16IndexForByte(xml, run.anchor.textStart - run.anchor.start),
			textEnd = utf16IndexForByte(xml, run.anchor.textEnd - run.anchor.start);
		const selfClosingName = xml.slice(0, textStart).match(/<([^\s/>]+)[^>]*\/\s*>$/)?.[1];
		const close = selfClosingName === undefined ? xml.slice(textEnd) : `</${selfClosingName}>${xml.slice(textEnd)}`;
		const openingBoundary =
			selfClosingName === undefined
				? run.anchor.textStart - run.anchor.start
				: encoder.encode(xml.slice(0, xml.indexOf(`<${selfClosingName}`) + selfClosingName.length + 2)).length;
		const adjusted = rewriteTextOpening(xml, openingBoundary, /^\s|\s$/.test(op.replacement));
		const sourceOpenStart =
			selfClosingName === undefined ? xml.lastIndexOf("<", textStart) : xml.indexOf(`<${selfClosingName}`);
		const adjustedOpenEnd = adjusted.indexOf(">", sourceOpenStart);
		if (sourceOpenStart < 0 || adjustedOpenEnd < 0) throw officeError("XML_INVALID");
		const replacement = encoder.encode(adjusted.slice(0, adjustedOpenEnd + 1) + escaped(op.replacement) + close);
		replacementTotal += replacement.length;
		semanticTotal += encoder.encode(op.replacement).length + encoder.encode(run.text).length;
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
			kind: "text_run",
		});
		diffs.push({ runId: run.id, before: run.text, after: op.replacement });
	}
	const startForRun = (runId: string): number =>
		snapshot.paragraphs.flatMap((paragraph) => paragraph.runs).find((run) => run.id === runId)?.anchor.start ??
		Number.MAX_SAFE_INTEGER;
	patches.sort((left, right) => left.start - right.start);
	diffs.sort((left, right) => startForRun(left.runId) - startForRun(right.runId));
	const orderedRuns = [...seen].sort((left, right) => startForRun(left) - startForRun(right));
	const body = {
		documentId: snapshot.documentId,
		baseRevision: snapshot.revision,
		resultingRevision: snapshot.revision + 1,
		sourceSha256: sha256(archive.serialize()),
		envelope,
		semanticDiff: diffs,
		touchedRuns: orderedRuns,
		touchedParts: envelope.operations.length ? [snapshot.mainPart] : [],
		patchManifest: patches,
		warnings: snapshot.warnings,
		expiresAt,
	};
	if (encoder.encode(canonical(body)).length > TRANSACTION_BUDGETS.maxPlanBytes)
		throw officeError("VALIDATION_FAILED");
	const plan = { ...body, planSha256: sha256(encoder.encode(canonical(body))) };
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
	const body = root.children.filter(
		(n) => n.tag.local === "body" && (n.tag.uri === WORD_NS || n.tag.uri === STRICT_WORD_NS),
	);
	if (
		root.tag.local !== "document" ||
		(root.tag.uri !== WORD_NS && root.tag.uri !== STRICT_WORD_NS) ||
		body.length !== 1 ||
		root.children.length !== 1
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
			const properties = r.children.find((n) => n.tag.local === "rPr" && n.tag.uri === r.tag.uri);
			const boldNode = properties?.children.find((x) => x.tag.local === "b" && x.tag.uri === r.tag.uri);
			const italicNode = properties?.children.find((x) => x.tag.local === "i" && x.tag.uri === r.tag.uri);
			const boldValue = boldNode === undefined ? false : onOff(boldNode.tag, r.tag.uri ?? "");
			const italicValue = italicNode === undefined ? false : onOff(italicNode.tag, r.tag.uri ?? "");
			const bold = boldValue ?? false;
			const italic = italicValue ?? false;
			const runBlockedReason =
				structuralReason ??
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
						const properties = r.children.find((n) => n.tag.local === "rPr" && n.tag.uri === r.tag.uri);
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
		};
	});
	return immutable({
		documentId,
		revision,
		mainPart: main,
		paragraphs: result,
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
	for (const op of value.operations) {
		if (
			!plain(op) ||
			Object.keys(op).length !== 4 ||
			op.type !== "replace_text_run" ||
			!plain(op.target) ||
			Object.keys(op.target).length !== 3 ||
			!plain(op.precondition) ||
			Object.keys(op.precondition).length !== 3 ||
			op.target.part !== "document" ||
			typeof op.target.paragraphId !== "string" ||
			typeof op.target.runId !== "string" ||
			encoder.encode(op.target.paragraphId).length > TRANSACTION_BUDGETS.maxIdBytes ||
			!scalar(op.target.paragraphId) ||
			encoder.encode(op.target.runId).length > TRANSACTION_BUDGETS.maxIdBytes ||
			!scalar(op.target.runId) ||
			typeof op.replacement !== "string" ||
			!scalar(op.replacement) ||
			encoder.encode(op.replacement).length > TRANSACTION_BUDGETS.maxReplacementBytes ||
			typeof op.precondition.documentRevision !== "number" ||
			!Number.isSafeInteger(op.precondition.documentRevision) ||
			typeof op.precondition.expectedText !== "string" ||
			!scalar(op.precondition.expectedText) ||
			encoder.encode(op.precondition.expectedText).length > TRANSACTION_BUDGETS.maxExpectedTextBytes ||
			encoder.encode(op.precondition.expectedText).length + encoder.encode(op.replacement).length >
				TRANSACTION_BUDGETS.maxExpectedTextBytes + TRANSACTION_BUDGETS.maxReplacementBytes ||
			typeof op.precondition.expectedTextSha256 !== "string" ||
			op.precondition.expectedTextSha256 !== sha256(encoder.encode(op.precondition.expectedText)) ||
			!/^[0-9a-f]{64}$/.test(op.precondition.expectedTextSha256)
		)
			throw officeError("VALIDATION_FAILED");
		expectedBytes += encoder.encode(op.precondition.expectedText).length;
		replacementBytes += encoder.encode(op.replacement).length;
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
function validatePatches(patches: readonly Patch[], length: number, part: string): void {
	let previousEnd = 0;
	let replacementTotal = 0;
	for (const patch of patches) {
		if (
			patch.part !== part ||
			!Number.isSafeInteger(patch.start) ||
			!Number.isSafeInteger(patch.end) ||
			patch.start < previousEnd ||
			patch.end <= patch.start ||
			patch.end > length ||
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
		previousEnd = patch.end;
	}
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
	if (plan.patchManifest.length !== plan.envelope.operations.length) throw officeError("VALIDATION_FAILED");
	const source = archive.read(current.mainPart);
	validatePatches(plan.patchManifest, source.length, current.mainPart);
	let content = new Uint8Array(source);
	for (let index = plan.patchManifest.length - 1; index >= 0; index -= 1) {
		const patch = plan.patchManifest[index];
		const replacement = fromB64(patch.replacementBase64);
		if (sha256(source.slice(patch.start, patch.end)) !== patch.preimageSha256)
			throw officeError("PRECONDITION_FAILED");
		const output = new Uint8Array(content.length - patch.end + patch.start + replacement.length);
		output.set(content.slice(0, patch.start));
		output.set(replacement, patch.start);
		output.set(content.slice(patch.end), patch.start + replacement.length);
		content = output;
	}
	if (plan.patchManifest.length === 0) return archive.serialize();
	const output = archive.replace(current.mainPart, content);
	const delta = verifyReplacement(archive.serialize(), output, current.mainPart, content);
	if (
		delta.changedEntries.length !== 1 ||
		delta.changedEntries[0] !== current.mainPart ||
		delta.unchangedEntries.length !== archive.entries().length - 1
	)
		throw officeError("ARCHIVE_INVALID");
	const reopened = PackageArchive.open(output);
	const checked = inspectDocx(reopened, current.documentId, plan.resultingRevision);
	for (const diff of plan.semanticDiff) {
		const found = checked.paragraphs.flatMap((paragraph) => paragraph.runs).find((run) => run.id === diff.runId);
		if (!found || found.text !== diff.after) throw officeError("PRECONDITION_FAILED");
	}
	return output;
}
