import { sha256 as hashSha256 } from "@noble/hashes/sha2.js";
import type { SaxesAttributeNS, SaxesTag } from "saxes";
import { SaxesParser } from "saxes";
import { officeError } from "./errors.ts";

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const STRICT_WORD_NS = "http://purl.oclc.org/ooxml/wordprocessingml/main";
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

export type RelatedPartKind = "header" | "footer";
export type RelatedPartBlockedReason =
	| "bookmark-boundary"
	| "comment-boundary"
	| "field-boundary"
	| "foreign-namespace"
	| "note-reference"
	| "tracked-revision"
	| "complex-run"
	| "unsupported-paragraph-boundary"
	| "xml-cdata"
	| "xml-comment";

export interface RelatedPartRunSnapshot {
	readonly id: string;
	readonly text: string;
	readonly editable: boolean;
	readonly blockedReason?: RelatedPartBlockedReason;
	readonly anchor: {
		readonly part: string;
		readonly start: number;
		readonly end: number;
		readonly textStart: number;
		readonly textEnd: number;
		readonly textHash: string;
		readonly wordPrefix: string;
	};
}

export interface RelatedPartParagraphSnapshot {
	readonly id: string;
	readonly runs: readonly RelatedPartRunSnapshot[];
	readonly editable: boolean;
	readonly blockedReason?: RelatedPartBlockedReason;
}

export interface RelatedPartSnapshot {
	readonly id: string;
	readonly relationshipId: string;
	readonly kind: RelatedPartKind;
	readonly path: string;
	readonly paragraphs: readonly RelatedPartParagraphSnapshot[];
	readonly blocked: boolean;
}

export interface CommentSnapshot {
	readonly id: string;
	readonly relationshipId: string;
	readonly commentId: string;
	readonly author: string;
	readonly date?: string;
	readonly initials?: string;
	readonly path: string;
	readonly paragraphs: readonly RelatedPartParagraphSnapshot[];
	readonly blocked: boolean;
}

export interface CommentsPartSnapshot {
	readonly id: string;
	readonly relationshipId: string;
	readonly path: string;
	readonly comments: readonly CommentSnapshot[];
	readonly blocked: boolean;
}

interface ParseLimits {
	readonly maxXmlBytes: number;
	readonly maxXmlDepth: number;
	readonly maxXmlNodes: number;
}

interface Node {
	tag: SaxesTag;
	readonly parent: Node | undefined;
	readonly start: number;
	readonly openEnd: number;
	closeStart: number;
	end: number;
	text: string;
	textStart: number;
	textEnd: number;
	readonly children: Node[];
	blocked: RelatedPartBlockedReason | undefined;
}

function hex(bytes: Uint8Array): string {
	return Array.from(hashSha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
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

function isWordNode(node: Node, local: string): boolean {
	return node.tag.local === local && (node.tag.uri === WORD_NS || node.tag.uri === STRICT_WORD_NS);
}

function blockedReasonForTag(tag: SaxesTag): RelatedPartBlockedReason | undefined {
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
	return undefined;
}

function firstBlockedReason(node: Node): RelatedPartBlockedReason | undefined {
	return node.blocked ?? node.children.map(firstBlockedReason).find((reason) => reason !== undefined);
}

function parseWordXml(bytes: Uint8Array, limits: ParseLimits): Node {
	if (bytes.length > limits.maxXmlBytes) throw officeError("XML_TOO_LARGE");
	let xml: string;
	try {
		xml = decoder.decode(bytes);
	} catch {
		throw officeError("XML_INVALID");
	}
	const map = offsets(xml);
	const parser = new SaxesParser({ xmlns: true, position: true, fragment: false });
	const stack: Node[] = [];
	let root: Node | undefined;
	let nodes = 0;
	let pendingStart = 0;
	let failure: Error | undefined;
	const abort = (error: Error): never => {
		failure = error;
		throw error;
	};
	parser.on("error", (error: Error) => {
		failure = error;
	});
	parser.on("doctype", () => abort(officeError("XML_DTD_FORBIDDEN")));
	parser.on("processinginstruction", (instruction) => {
		if (instruction.target.toLowerCase() !== "xml") abort(officeError("XML_PI_FORBIDDEN"));
	});
	parser.on("opentagstart", () => {
		if (++nodes > limits.maxXmlNodes || stack.length >= limits.maxXmlDepth) abort(officeError("XML_INVALID"));
		pendingStart = map[sourceTagStart(xml, parser.position)];
	});
	parser.on("opentag", (tag: SaxesTag) => {
		const parent = stack.at(-1);
		const node: Node = {
			tag: { ...tag, attributes: { ...tag.attributes } },
			parent,
			start: pendingStart,
			openEnd: map[parser.position],
			closeStart: map[parser.position],
			end: map[parser.position],
			text: "",
			textStart: map[parser.position],
			textEnd: map[parser.position],
			children: [],
			blocked: parent?.blocked,
		};
		if (parent) parent.children.push(node);
		else if (root) abort(officeError("XML_INVALID"));
		else root = node;
		stack.push(node);
		node.blocked ??= blockedReasonForTag(tag);
	});
	parser.on("text", (text: string) => {
		const node = stack.at(-1);
		if (!node) {
			if (text.trim()) failure = officeError("XML_INVALID");
			return;
		}
		if (!node.text) node.textStart = node.openEnd;
		node.text += text;
	});
	parser.on("cdata", () => {
		if (stack.length === 0) abort(officeError("XML_INVALID"));
		for (const node of stack) node.blocked ??= "xml-cdata";
	});
	parser.on("comment", () => {
		if (stack.length === 0) abort(officeError("XML_INVALID"));
		for (const node of stack) node.blocked ??= "xml-comment";
	});
	parser.on("closetag", (tag: SaxesTag) => {
		const node = stack.pop();
		if (!node) return;
		node.tag = { ...tag, attributes: { ...tag.attributes } };
		node.closeStart = tag.isSelfClosing ? node.openEnd : map[closingStart(xml, parser.position, tag.name)];
		node.end = map[parser.position];
		if (node.tag.local === "t") node.textEnd = tag.isSelfClosing ? node.openEnd : node.closeStart;
	});
	try {
		parser.write(xml).close();
	} catch {
		throw officeError("XML_INVALID");
	}
	if (failure || stack.length || !root) throw officeError("XML_INVALID");
	return root;
}

function inspectParagraphs(container: Node, partId: string, path: string): readonly RelatedPartParagraphSnapshot[] {
	return container.children
		.filter((node) => isWordNode(node, "p"))
		.map((paragraph, paragraphIndex): RelatedPartParagraphSnapshot => {
			const paragraphId = `${partId}:p-${paragraphIndex}`;
			const directRuns = paragraph.children.filter((node) => isWordNode(node, "r"));
			const boundary = paragraph.children.find((node) => !isWordNode(node, "pPr") && !isWordNode(node, "r"));
			const paragraphBlocked =
				paragraph.blocked ??
				(boundary
					? (firstBlockedReason(boundary) ?? blockedReasonForTag(boundary.tag) ?? "unsupported-paragraph-boundary")
					: undefined);
			const runs = directRuns.map((run, runIndex): RelatedPartRunSnapshot => {
				const texts = run.children.filter((node) => isWordNode(node, "t"));
				const unsupported = run.children.find((node) => !isWordNode(node, "rPr") && !isWordNode(node, "t"));
				const blocked =
					firstBlockedReason(run) ??
					(unsupported ? (blockedReasonForTag(unsupported.tag) ?? "complex-run") : undefined) ??
					(texts.length === 1 && texts[0].children.length === 0 ? undefined : "complex-run") ??
					paragraphBlocked;
				const text = texts[0]?.text ?? "";
				return {
					id: `${paragraphId}:r-${runIndex}`,
					text,
					editable: blocked === undefined,
					blockedReason: blocked,
					anchor: {
						part: path,
						start: run.start,
						end: run.end,
						textStart: texts[0]?.textStart ?? run.openEnd,
						textEnd: texts[0]?.textEnd ?? run.openEnd,
						textHash: hex(encoder.encode(text)),
						wordPrefix: run.tag.prefix ?? "",
					},
				};
			});
			const blocked = paragraphBlocked ?? runs.find((run) => !run.editable)?.blockedReason;
			return { id: paragraphId, runs, editable: blocked === undefined, blockedReason: blocked };
		});
}

function wordAttribute(tag: SaxesTag, local: string): string | undefined {
	return Object.values(tag.attributes).find(
		(attribute): attribute is SaxesAttributeNS =>
			typeof attribute !== "string" &&
			attribute.local === local &&
			(attribute.uri === WORD_NS || attribute.uri === STRICT_WORD_NS),
	)?.value;
}

export function inspectRelatedWordPart(
	bytes: Uint8Array,
	part: { readonly relationshipId: string; readonly kind: RelatedPartKind; readonly path: string },
	limits: ParseLimits,
): RelatedPartSnapshot {
	const root = parseWordXml(bytes, limits);
	const expectedRoot = part.kind === "header" ? "hdr" : "ftr";
	if (!isWordNode(root, expectedRoot)) throw officeError("XML_INVALID");
	const hasUnsupportedRootContent = root.children.some((node) => !isWordNode(node, "p"));
	const partId = `${part.kind}:${part.relationshipId}`;
	const paragraphs = inspectParagraphs(root, partId, part.path);
	return {
		id: partId,
		relationshipId: part.relationshipId,
		kind: part.kind,
		path: part.path,
		paragraphs,
		blocked: hasUnsupportedRootContent || paragraphs.some((paragraph) => !paragraph.editable),
	};
}

export function inspectCommentsWordPart(
	bytes: Uint8Array,
	part: { readonly relationshipId: string; readonly path: string },
	limits: ParseLimits,
): CommentsPartSnapshot {
	const root = parseWordXml(bytes, limits);
	if (!isWordNode(root, "comments")) throw officeError("XML_INVALID");
	const commentsNodes = root.children.filter((node) => isWordNode(node, "comment"));
	if (commentsNodes.length !== root.children.length) throw officeError("XML_INVALID");
	const seen = new Set<string>();
	const partId = `comments:${part.relationshipId}`;
	const comments = commentsNodes.map((node): CommentSnapshot => {
		const commentId = wordAttribute(node.tag, "id");
		const author = wordAttribute(node.tag, "author");
		if (commentId === undefined || author === undefined || seen.has(commentId)) throw officeError("XML_INVALID");
		seen.add(commentId);
		const id = `comment:${part.relationshipId}:${commentId}`;
		const paragraphs = inspectParagraphs(node, id, part.path);
		const unsupported = node.children.some((child) => !isWordNode(child, "p"));
		return {
			id,
			relationshipId: part.relationshipId,
			commentId,
			author,
			date: wordAttribute(node.tag, "date"),
			initials: wordAttribute(node.tag, "initials"),
			path: part.path,
			paragraphs,
			blocked: unsupported || paragraphs.some((paragraph) => !paragraph.editable),
		};
	});
	return {
		id: partId,
		relationshipId: part.relationshipId,
		path: part.path,
		comments,
		blocked: comments.some((comment) => comment.blocked),
	};
}
