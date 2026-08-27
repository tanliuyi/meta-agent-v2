import { createHash } from "node:crypto";
import type { PackageArchive } from "./archive.ts";
import { type DocxDocumentModel, type DocxRawAnchor, inspectDocxModel } from "./docx-document.ts";
import { officeError } from "./errors.ts";

export const DOCX_OPERATION_PROTOCOL_VERSION = 1 as const;
export const DOCX_MAX_OPERATION_COUNT = 64;
export const DOCX_MAX_ID_BYTES = 128;
export const DOCX_MAX_TEXT_BYTES = 64 * 1024;
export const DOCX_MAX_ENVELOPE_TEXT_BYTES = 256 * 1024;

export interface ReplaceTextRunOperation {
	readonly type: "replace_text_run";
	readonly target: {
		readonly part: "document";
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

export type DocumentOperation = ReplaceTextRunOperation;

export interface DocumentOperationEnvelope {
	readonly protocolVersion: 1;
	readonly operations: ReadonlyArray<DocumentOperation>;
}

export interface DocxPlanRequest {
	readonly documentId: string;
	readonly currentRevision: number;
	readonly expiresAt: number;
	readonly envelope: unknown;
}

export interface DocxSemanticDiff {
	readonly operationIndex: number;
	readonly type: "replace_text_run";
	readonly paragraphId: string;
	readonly runId: string;
	readonly beforeText: string;
	readonly afterText: string;
}

export interface DocxTouchedRun {
	readonly paragraphId: string;
	readonly runId: string;
}

export interface DocxTouchedXmlSlice {
	readonly operationIndex: number;
	readonly paragraphId: string;
	readonly runId: string;
	readonly part: "document";
	readonly start: number;
	readonly end: number;
	readonly sha256: string;
}

export interface DocxTouchedEntry {
	readonly path: string;
	readonly sha256: string;
}

export interface DocxTransactionPlan {
	readonly format: "docx";
	readonly documentId: string;
	readonly baseRevision: number;
	readonly sourceSha256: string;
	readonly expiresAt: number;
	readonly envelope: DocumentOperationEnvelope;
	readonly semanticDiff: ReadonlyArray<DocxSemanticDiff>;
	readonly touchedRuns: ReadonlyArray<DocxTouchedRun>;
	readonly touchedXmlSlices: ReadonlyArray<DocxTouchedXmlSlice>;
	readonly touchedEntries: ReadonlyArray<DocxTouchedEntry>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function dataEnumerableDescriptor(value: object, key: PropertyKey): PropertyDescriptor | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor?.enumerable && Object.hasOwn(descriptor, "value") ? descriptor : undefined;
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
	const expected = new Set<PropertyKey>(keys);
	const actual = Reflect.ownKeys(value);
	if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !expected.has(key)))
		return false;
	return keys.every((key) => dataEnumerableDescriptor(value, key) !== undefined);
}

function isPlainArray(value: unknown): value is ReadonlyArray<unknown> {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
	const array = value as unknown[];
	const ownKeys = Reflect.ownKeys(array);
	const lengthDescriptor = Object.getOwnPropertyDescriptor(array, "length");
	if (lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, "value") || lengthDescriptor.enumerable)
		return false;
	const length = lengthDescriptor.value;
	if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || ownKeys.length !== length + 1)
		return false;
	for (const key of ownKeys) {
		if (key === "length") continue;
		if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) return false;
		const index = Number(key);
		if (index >= length || dataEnumerableDescriptor(array, key) === undefined) return false;
	}
	for (let index = 0; index < length; index++) {
		if (dataEnumerableDescriptor(array, String(index)) === undefined) return false;
	}
	return true;
}

function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function hasValidSurrogatePairs(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			if (++index >= value.length) return false;
			const low = value.charCodeAt(index);
			if (low < 0xdc00 || low > 0xdfff) return false;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return false;
		}
	}
	return true;
}

function validBoundedString(value: unknown, maxBytes: number, allowEmpty: boolean): value is string {
	return (
		typeof value === "string" &&
		hasValidSurrogatePairs(value) &&
		(allowEmpty || value.length > 0) &&
		utf8Bytes(value) <= maxBytes
	);
}

function validId(value: unknown): value is string {
	return validBoundedString(value, DOCX_MAX_ID_BYTES, false) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function validRevision(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validExpiry(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validSha256(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function sha256Text(value: string): string {
	return sha256(new TextEncoder().encode(value));
}

function validationFailed(): never {
	throw officeError("VALIDATION_FAILED");
}

function validateReplaceOperation(value: unknown): ReplaceTextRunOperation {
	if (!isPlainRecord(value) || !hasExactKeys(value, ["type", "target", "precondition", "replacement"]))
		validationFailed();
	const type = value.type;
	const replacement = value.replacement;
	if (type !== "replace_text_run" || !validBoundedString(replacement, DOCX_MAX_TEXT_BYTES, true)) validationFailed();
	const target = value.target;
	if (!isPlainRecord(target) || !hasExactKeys(target, ["part", "paragraphId", "runId"])) validationFailed();
	if (target.part !== "document" || !validId(target.paragraphId) || !validId(target.runId)) validationFailed();
	const precondition = value.precondition;
	if (
		!isPlainRecord(precondition) ||
		!hasExactKeys(precondition, ["documentRevision", "expectedText", "expectedTextSha256"])
	)
		validationFailed();
	if (
		!validRevision(precondition.documentRevision) ||
		!validBoundedString(precondition.expectedText, DOCX_MAX_TEXT_BYTES, true) ||
		!validSha256(precondition.expectedTextSha256)
	)
		validationFailed();
	return {
		type: "replace_text_run",
		target: { part: "document", paragraphId: target.paragraphId, runId: target.runId },
		precondition: {
			documentRevision: precondition.documentRevision,
			expectedText: precondition.expectedText,
			expectedTextSha256: precondition.expectedTextSha256,
		},
		replacement,
	};
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor !== undefined && Object.hasOwn(descriptor, "value")) deepFreeze(descriptor.value);
	}
	Object.freeze(value);
	return value;
}

export function validateDocumentOperationEnvelope(value: unknown): DocumentOperationEnvelope {
	if (!isPlainRecord(value) || !hasExactKeys(value, ["protocolVersion", "operations"])) validationFailed();
	if (
		value.protocolVersion !== DOCX_OPERATION_PROTOCOL_VERSION ||
		!isPlainArray(value.operations) ||
		value.operations.length > DOCX_MAX_OPERATION_COUNT
	)
		validationFailed();
	const operations: DocumentOperation[] = [];
	let totalTextBytes = 0;
	for (const operation of value.operations) {
		const normalized = validateReplaceOperation(operation);
		totalTextBytes += utf8Bytes(normalized.precondition.expectedText) + utf8Bytes(normalized.replacement);
		if (totalTextBytes > DOCX_MAX_ENVELOPE_TEXT_BYTES) validationFailed();
		operations.push(normalized);
	}
	return deepFreeze({ protocolVersion: DOCX_OPERATION_PROTOCOL_VERSION, operations });
}

function targetKey(target: ReplaceTextRunOperation["target"]): string {
	return `${target.paragraphId}\u0000${target.runId}`;
}

function findRun(
	model: DocxDocumentModel,
	paragraphId: string,
	runId: string,
): { readonly text: string; readonly editable: boolean; readonly anchor: DocxRawAnchor } | undefined {
	const paragraph = model.snapshot.paragraphs.find((item) => item.id === paragraphId);
	const run = paragraph?.runs.find((item) => item.id === runId);
	const anchor = run === undefined ? undefined : model.rawAnchors.get(run.id);
	return run === undefined || anchor === undefined ? undefined : { text: run.text, editable: run.editable, anchor };
}

export function planDocxOperations(archive: PackageArchive, request: DocxPlanRequest): DocxTransactionPlan {
	const envelope = validateDocumentOperationEnvelope(request.envelope);
	if (!validId(request.documentId) || !validRevision(request.currentRevision) || !validExpiry(request.expiresAt))
		validationFailed();
	const archiveBytes = archive.serialize();
	const sourceSha256 = sha256(archiveBytes);
	const semanticDiff: DocxSemanticDiff[] = [];
	const touchedRuns: DocxTouchedRun[] = [];
	const touchedXmlSlices: DocxTouchedXmlSlice[] = [];
	const touchedEntries: DocxTouchedEntry[] = [];
	if (envelope.operations.length > 0) {
		const model = inspectDocxModel(archive);
		const mainPartSha256 = sha256(model.source);
		touchedEntries.push({ path: model.snapshot.mainPartPath, sha256: mainPartSha256 });
		const seen = new Set<string>();
		for (const [operationIndex, operation] of envelope.operations.entries()) {
			const key = targetKey(operation.target);
			if (seen.has(key)) validationFailed();
			seen.add(key);
			const found = findRun(model, operation.target.paragraphId, operation.target.runId);
			if (found === undefined) throw officeError("TARGET_NOT_FOUND");
			if (!found.editable || found.anchor.text === undefined || found.anchor.textElement === undefined)
				throw officeError("OPERATION_BLOCKED");
			if (
				operation.precondition.documentRevision !== request.currentRevision ||
				operation.precondition.expectedText !== found.text ||
				operation.precondition.expectedTextSha256 !== sha256Text(found.text)
			) {
				throw officeError("PRECONDITION_FAILED");
			}
			if (operation.replacement === found.text) validationFailed();
			semanticDiff.push({
				operationIndex,
				type: operation.type,
				paragraphId: operation.target.paragraphId,
				runId: operation.target.runId,
				beforeText: found.text,
				afterText: operation.replacement,
			});
			touchedRuns.push({ paragraphId: operation.target.paragraphId, runId: operation.target.runId });
			touchedXmlSlices.push({
				operationIndex,
				paragraphId: operation.target.paragraphId,
				runId: operation.target.runId,
				part: "document",
				start: found.anchor.textElement.start,
				end: found.anchor.textElement.end,
				sha256: sha256(model.source.subarray(found.anchor.textElement.start, found.anchor.textElement.end)),
			});
		}
	}
	const plan: DocxTransactionPlan = {
		format: "docx",
		documentId: request.documentId,
		baseRevision: request.currentRevision,
		sourceSha256,
		expiresAt: request.expiresAt,
		envelope,
		semanticDiff,
		touchedRuns,
		touchedXmlSlices,
		touchedEntries,
	};
	return deepFreeze(plan);
}
