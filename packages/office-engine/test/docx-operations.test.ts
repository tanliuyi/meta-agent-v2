import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { PackageArchive } from "../src/archive.ts";
import {
	TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP,
	TRANSITIONAL_PACKAGE_RELATIONSHIPS_NAMESPACE,
} from "../src/docx.ts";
import {
	DOCX_MAX_ENVELOPE_TEXT_BYTES,
	DOCX_MAX_OPERATION_COUNT,
	DOCX_MAX_TEXT_BYTES,
	OfficeEngineError,
	planDocxOperations,
	validateDocumentOperationEnvelope,
	WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE,
} from "../src/index.ts";

const encoder = new TextEncoder();
const wordNamespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function hash(value: Uint8Array | string): string {
	return createHash("sha256")
		.update(typeof value === "string" ? encoder.encode(value) : value)
		.digest("hex");
}

function archive(documentXml: string, mainPartPath = "word/document.xml"): PackageArchive {
	const contentTypes = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${mainPartPath}" ContentType="${WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE}"/></Types>`;
	const relationships = `<Relationships xmlns="${TRANSITIONAL_PACKAGE_RELATIONSHIPS_NAMESPACE}"><Relationship Id="rId1" Type="${TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP}" Target="${mainPartPath}"/></Relationships>`;
	return PackageArchive.open(
		zipSync({
			"[Content_Types].xml": encoder.encode(contentTypes),
			"_rels/.rels": encoder.encode(relationships),
			[mainPartPath]: encoder.encode(documentXml),
		}),
	);
}

function documentXml(): string {
	return `<w:document xmlns:w="${wordNamespace}"><w:body><w:p><w:r><w:t>前😀</w:t></w:r><w:r><w:t>second</w:t></w:r></w:p></w:body></w:document>`;
}

function operation(
	paragraphId: string,
	runId: string,
	expectedText: string,
	replacement: string,
	revision = 7,
	expectedTextSha256 = hash(expectedText),
): Record<string, unknown> {
	return {
		type: "replace_text_run",
		target: { part: "document", paragraphId, runId },
		precondition: { documentRevision: revision, expectedText, expectedTextSha256 },
		replacement,
	};
}

function request(
	envelope: unknown,
	currentRevision = 7,
	expiresAt = 1234,
): { documentId: string; currentRevision: number; expiresAt: number; envelope: unknown } {
	return { documentId: "doc-1", currentRevision, expiresAt, envelope };
}

function envelope(operations: ReadonlyArray<unknown>): unknown {
	return { protocolVersion: 1, operations };
}

function expectCode(action: () => unknown, code: string): void {
	expect(action).toThrowError(OfficeEngineError);
	try {
		action();
	} catch (error: unknown) {
		if (error instanceof OfficeEngineError) expect(error.code).toBe(code);
	}
}

function assertDeepFrozen(value: unknown): void {
	if (typeof value !== "object" || value === null) return;
	expect(Object.isFrozen(value)).toBe(true);
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor !== undefined && Object.hasOwn(descriptor, "value")) assertDeepFrozen(descriptor.value);
	}
}

const archiveForPlan = (): PackageArchive => archive(documentXml());

describe("DOCX operation planner", () => {
	it("creates an ordered multi-run plan with source and self-describing slice manifests", () => {
		const input = archiveForPlan();
		const plan = planDocxOperations(
			input,
			request(envelope([operation("p-0", "r-0-0", "前😀", "中文"), operation("p-0", "r-0-1", "second", "third")])),
		);
		expect(plan).toMatchObject({ format: "docx", documentId: "doc-1", baseRevision: 7, expiresAt: 1234 });
		expect(plan.envelope.operations.map((item) => item.target.runId)).toEqual(["r-0-0", "r-0-1"]);
		expect(plan.semanticDiff.map((item) => [item.operationIndex, item.beforeText, item.afterText])).toEqual([
			[0, "前😀", "中文"],
			[1, "second", "third"],
		]);
		expect(plan.touchedRuns).toEqual([
			{ paragraphId: "p-0", runId: "r-0-0" },
			{ paragraphId: "p-0", runId: "r-0-1" },
		]);
		expect(plan.touchedEntries).toEqual([
			{ path: "word/document.xml", sha256: hash(input.read("word/document.xml")) },
		]);
		expect(plan.touchedXmlSlices).toHaveLength(2);
		for (const [index, slice] of plan.touchedXmlSlices.entries()) {
			expect(slice).toMatchObject({
				operationIndex: index,
				paragraphId: "p-0",
				runId: `r-0-${index}`,
				part: "document",
			});
			expect(slice.end).toBeGreaterThan(slice.start);
			expect(slice.sha256).toBe(hash(input.read("word/document.xml").subarray(slice.start, slice.end)));
		}
		expect(plan.sourceSha256).toBe(hash(input.serialize()));
	});

	it("uses the resolved main part path in the touched-entry manifest", () => {
		const input = archive(documentXml(), "custom/main.xml");
		const plan = planDocxOperations(input, request(envelope([operation("p-0", "r-0-0", "前😀", "中文")])));
		expect(plan.touchedEntries).toEqual([{ path: "custom/main.xml", sha256: hash(input.read("custom/main.xml")) }]);
	});
	it("returns a normalized frozen envelope and deeply freezes the complete plan", () => {
		const source = envelope([operation("p-0", "r-0-0", "前😀", "x")]);
		const normalized = validateDocumentOperationEnvelope(source);
		assertDeepFrozen(normalized);
		const plan = planDocxOperations(archiveForPlan(), request(source));
		assertDeepFrozen(plan);
		expect(() => {
			(plan as { documentId: string }).documentId = "changed";
		}).toThrow();
		expect(() => {
			(plan.envelope.operations[0] as { replacement: string }).replacement = "changed";
		}).toThrow();
	});

	it("rejects isolated surrogates while accepting valid astral pairs", () => {
		expect(() => validateDocumentOperationEnvelope(envelope([operation("p-0", "r-0-0", "😀", "x")]))).not.toThrow();
		for (const isolated of ["\ud800", "\udc00"]) {
			expectCode(
				() => validateDocumentOperationEnvelope(envelope([operation("p-0", "r-0-0", isolated, "x")])),
				"VALIDATION_FAILED",
			);
			expectCode(
				() => validateDocumentOperationEnvelope(envelope([operation("p-0", "r-0-0", "x", isolated)])),
				"VALIDATION_FAILED",
			);
		}
	});
	it("checks revision, text, and hash as independent preconditions", () => {
		const input = archiveForPlan();
		expectCode(
			() => planDocxOperations(input, request(envelope([operation("p-0", "r-0-0", "前😀", "x", 8)]))),
			"PRECONDITION_FAILED",
		);
		expectCode(
			() => planDocxOperations(input, request(envelope([operation("p-0", "r-0-0", "wrong", "x")]))),
			"PRECONDITION_FAILED",
		);
		expectCode(
			() =>
				planDocxOperations(input, request(envelope([operation("p-0", "r-0-0", "前😀", "x", 7, "0".repeat(64))]))),
			"PRECONDITION_FAILED",
		);
	});

	it("rejects blocked, missing, duplicate, no-op, and partial batches", () => {
		const input = archiveForPlan();
		const valid = operation("p-0", "r-0-0", "前😀", "x");
		expectCode(
			() => planDocxOperations(input, request(envelope([operation("p-0", "r-0-9", "x", "y")]))),
			"TARGET_NOT_FOUND",
		);
		expectCode(() => planDocxOperations(input, request(envelope([valid, valid]))), "VALIDATION_FAILED");
		expectCode(
			() => planDocxOperations(input, request(envelope([operation("p-0", "r-0-0", "前😀", "前😀")]))),
			"VALIDATION_FAILED",
		);
		expectCode(
			() =>
				planDocxOperations(
					archive(
						`<w:document xmlns:w="${wordNamespace}"><w:body><w:p><w:ins><w:r><w:t>tracked</w:t></w:r></w:ins></w:p></w:body></w:document>`,
					),
					request(envelope([operation("p-0", "r-0-0", "tracked", "x")])),
				),
			"OPERATION_BLOCKED",
		);
		expectCode(
			() => planDocxOperations(input, request(envelope([valid, operation("p-0", "r-0-9", "x", "y")]))),
			"TARGET_NOT_FOUND",
		);
	});

	it("rejects strict schema violations, symbols, hidden keys, accessors, and negative expiry", () => {
		const valid = operation("p-0", "r-0-0", "前😀", "x");
		const extraEnvelope = { protocolVersion: 1, operations: [valid], extra: true };
		const symbolEnvelope = { protocolVersion: 1, operations: [] as unknown[] } as Record<PropertyKey, unknown>;
		symbolEnvelope[Symbol("extra")] = true;
		const hiddenEnvelope = { protocolVersion: 1, operations: [] as unknown[] };
		Object.defineProperty(hiddenEnvelope, "hidden", { value: true, enumerable: false });
		const accessor = { protocolVersion: 1, operations: [valid] } as {
			protocolVersion: number;
			operations: unknown[];
		};
		Object.defineProperty(accessor, "protocolVersion", { get: () => 1, enumerable: true });
		const exotic = Object.create({ protocolVersion: 1, operations: [] });
		expectCode(() => validateDocumentOperationEnvelope(extraEnvelope), "VALIDATION_FAILED");
		expectCode(() => validateDocumentOperationEnvelope(symbolEnvelope), "VALIDATION_FAILED");
		expectCode(() => validateDocumentOperationEnvelope(hiddenEnvelope), "VALIDATION_FAILED");
		expectCode(() => validateDocumentOperationEnvelope(accessor), "VALIDATION_FAILED");
		expectCode(() => validateDocumentOperationEnvelope(exotic), "VALIDATION_FAILED");
		expectCode(() => validateDocumentOperationEnvelope({ protocolVersion: 2, operations: [] }), "VALIDATION_FAILED");
		expectCode(() => planDocxOperations(archiveForPlan(), request(envelope([]), 7, -1)), "VALIDATION_FAILED");
	});

	it("enforces operation and UTF-8 aggregate limits", () => {
		const valid = operation("p-0", "r-0-0", "x", "y");
		const tooMany = Array.from({ length: DOCX_MAX_OPERATION_COUNT + 1 }, (_, index) =>
			operation("p-0", `r-${index}`, "x", "y"),
		);
		expectCode(() => validateDocumentOperationEnvelope(envelope(tooMany)), "VALIDATION_FAILED");
		const longText = "a".repeat(DOCX_MAX_TEXT_BYTES + 1);
		expectCode(
			() => validateDocumentOperationEnvelope(envelope([operation("p-0", "r-0-0", longText, "x")])),
			"VALIDATION_FAILED",
		);
		const chunk = "a".repeat(Math.floor(DOCX_MAX_TEXT_BYTES / 2));
		const aggregate = Array.from({ length: 5 }, (_, index) => operation("p-0", `r-${index}`, chunk, chunk));
		expect(2 * 5 * encoder.encode(chunk).byteLength).toBeGreaterThan(DOCX_MAX_ENVELOPE_TEXT_BYTES);
		expectCode(() => validateDocumentOperationEnvelope(envelope(aggregate)), "VALIDATION_FAILED");
		expect(valid).toBeDefined();
	});

	it("handles empty text and decoded Unicode entities with full raw w:t slice hashes", () => {
		const xml = `<w:document xmlns:w="${wordNamespace}"><w:body><w:p><w:r><w:t></w:t></w:r><w:r><w:t>A &amp; 中😀é</w:t></w:r></w:p></w:body></w:document>`;
		const input = archive(xml);
		const modelText = "A & 中😀é";
		const plan = planDocxOperations(
			input,
			request(envelope([operation("p-0", "r-0-0", "", "filled"), operation("p-0", "r-0-1", modelText, "changed")])),
		);
		const documentBytes = input.read("word/document.xml");
		for (const slice of plan.touchedXmlSlices)
			expect(slice.sha256).toBe(hash(documentBytes.subarray(slice.start, slice.end)));
		expect(plan.semanticDiff[1].beforeText).toBe(modelText);
	});

	it("keeps an empty envelope bound to the source without declaring touched entries", () => {
		const input = archiveForPlan();
		const sourceSha256 = hash(input.serialize());
		const plan = planDocxOperations(input, request(envelope([]), 0, Number.MAX_SAFE_INTEGER));
		expect(plan.semanticDiff).toEqual([]);
		expect(plan.touchedRuns).toEqual([]);
		expect(plan.touchedXmlSlices).toEqual([]);
		expect(plan.touchedEntries).toEqual([]);
		expect(plan.sourceSha256).toBe(sourceSha256);
		expect(JSON.stringify(plan)).not.toContain("<w:document");
	});

	it("validates envelopes independently before any archive parsing", () => {
		const invalid = { protocolVersion: 99, operations: [] };
		expectCode(() => validateDocumentOperationEnvelope(invalid), "VALIDATION_FAILED");
		expectCode(
			() =>
				planDocxOperations(
					{
						serialize: () => {
							throw new Error("archive parsed");
						},
					} as never,
					request(invalid),
				),
			"VALIDATION_FAILED",
		);
	});
});
