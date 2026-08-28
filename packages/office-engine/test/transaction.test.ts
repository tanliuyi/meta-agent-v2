import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
	commitDocx,
	inspectDocx,
	OfficeEngineError,
	PackageArchive,
	planDocx,
	sha256Hex,
	TRANSACTION_BUDGETS,
	validateDocumentOperationEnvelope,
} from "../src/index.ts";

const main =
	'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr/><w:r><w:rPr><w:b/></w:rPr><w:t>Hello</w:t></w:r></w:p></w:body></w:document>';
const multiMain =
	'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>One</w:t></w:r><w:r><w:t>Two</w:t></w:r></w:p></w:body></w:document>';
const contentTypes =
	'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const rels =
	'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
const fixture = (): Uint8Array =>
	zipSync({
		"[Content_Types].xml": new TextEncoder().encode(contentTypes),
		"_rels/.rels": new TextEncoder().encode(rels),
		"word/document.xml": new TextEncoder().encode(main),
		"docProps/custom.xml": new TextEncoder().encode("keep"),
	});
const fixtureWithMain = (document: string, level: 0 | 6 = 6): Uint8Array =>
	zipSync({
		"[Content_Types].xml": [new TextEncoder().encode(contentTypes), { level }],
		"_rels/.rels": [new TextEncoder().encode(rels), { level }],
		"word/document.xml": [new TextEncoder().encode(document), { level }],
	});
const fixtureWithRelatedParts = (): Uint8Array =>
	zipSync({
		"[Content_Types].xml": new TextEncoder().encode(
			contentTypes.replace(
				"</Types>",
				'<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>',
			),
		),
		"_rels/.rels": new TextEncoder().encode(rels),
		"word/document.xml": new TextEncoder().encode(main),
		"word/_rels/document.xml.rels": new TextEncoder().encode(
			'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>',
		),
		"word/header1.xml": new TextEncoder().encode(
			'\uFEFF<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Header</w:t></w:r></w:p></w:hdr>',
		),
		"word/footer1.xml": new TextEncoder().encode(
			'\uFEFF<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Footer</w:t></w:r></w:p></w:ftr>',
		),
		"docProps/custom.xml": new TextEncoder().encode("keep-related"),
	});
function expectCode(action: () => unknown, code: string): void {
	try {
		action();
	} catch (error: unknown) {
		expect(error).toBeInstanceOf(OfficeEngineError);
		if (error instanceof OfficeEngineError) expect(error.code).toBe(code);
		return;
	}
	throw new Error(`expected ${code}`);
}

describe("P1 DOCX transaction", () => {
	it("inspects, plans, patches, reopens, and preserves the untouched entry", () => {
		const archive = PackageArchive.open(fixture());
		const snapshot = inspectDocx(archive, "doc-1");
		const run = snapshot.paragraphs[0].runs[0];
		const plan = planDocx(
			archive,
			snapshot,
			{
				protocolVersion: 1,
				operations: [
					{
						type: "replace_text_run",
						target: { part: "document", paragraphId: "p-0", runId: "r-0-0" },
						precondition: { documentRevision: 1, expectedText: "Hello", expectedTextSha256: run.anchor.textHash },
						replacement: "A&B",
					},
				],
			},
			Date.now() + 10000,
		);
		const output = commitDocx(archive, snapshot, plan);
		const reopened = PackageArchive.open(output);
		const changed = new TextDecoder().decode(reopened.read("word/document.xml"));
		expect(changed).toContain("A&amp;B");
		expect(reopened.read("docProps/custom.xml")).toEqual(archive.read("docProps/custom.xml"));
	});
	it("edits existing header and footer runs in one verified multi-part transaction", () => {
		const archive = PackageArchive.open(fixtureWithRelatedParts());
		const snapshot = inspectDocx(archive, "related");
		expect(snapshot.relatedParts.map((part) => ({ id: part.id, kind: part.kind }))).toEqual([
			{ id: "footer:rFooter", kind: "footer" },
			{ id: "header:rHeader", kind: "header" },
		]);
		const [footer, header] = snapshot.relatedParts;
		const footerRun = footer.paragraphs[0].runs[0];
		const headerRun = header.paragraphs[0].runs[0];
		expect(new Set([footerRun.id, headerRun.id, snapshot.paragraphs[0].runs[0].id]).size).toBe(3);
		const plan = planDocx(
			archive,
			snapshot,
			{
				protocolVersion: 1,
				operations: [
					{
						type: "replace_related_text_run",
						target: {
							part: "header",
							relatedPartId: header.id,
							paragraphId: header.paragraphs[0].id,
							runId: headerRun.id,
						},
						precondition: {
							documentRevision: 1,
							expectedText: headerRun.text,
							expectedTextSha256: headerRun.anchor.textHash,
						},
						replacement: "A&B Header",
					},
					{
						type: "replace_related_text_run",
						target: {
							part: "footer",
							relatedPartId: footer.id,
							paragraphId: footer.paragraphs[0].id,
							runId: footerRun.id,
						},
						precondition: {
							documentRevision: 1,
							expectedText: footerRun.text,
							expectedTextSha256: footerRun.anchor.textHash,
						},
						replacement: "Next Footer",
					},
				],
			},
			Date.now() + 10_000,
		);
		expect(plan.touchedParts).toEqual(["word/footer1.xml", "word/header1.xml"]);
		expect(plan.semanticDiff).toMatchObject([
			{ type: "related-text", part: "header", relatedPartId: header.id, after: "A&B Header" },
			{ type: "related-text", part: "footer", relatedPartId: footer.id, after: "Next Footer" },
		]);
		const output = commitDocx(archive, snapshot, plan);
		const reopenedArchive = PackageArchive.open(output);
		expect(new TextDecoder().decode(reopenedArchive.read("word/header1.xml"))).toContain("A&amp;B Header");
		expect(new TextDecoder().decode(reopenedArchive.read("word/footer1.xml"))).toContain("Next Footer");
		expect(reopenedArchive.read("word/_rels/document.xml.rels")).toEqual(
			archive.read("word/_rels/document.xml.rels"),
		);
		expect(reopenedArchive.read("docProps/custom.xml")).toEqual(archive.read("docProps/custom.xml"));
		const reopened = inspectDocx(reopenedArchive, "related", 2);
		expect(reopened.relatedParts[0].paragraphs[0].runs[0].id).toBe(footerRun.id);
		expect(reopened.relatedParts[1].paragraphs[0].runs[0].id).toBe(headerRun.id);
		expect(reopened.relatedParts[0].paragraphs[0].runs[0].text).toBe("Next Footer");
		expect(reopened.relatedParts[1].paragraphs[0].runs[0].text).toBe("A&B Header");
	});

	it("edits an existing comment text run without changing its document anchor", () => {
		const source = new Uint8Array(readFileSync(resolve(import.meta.dirname, "corpus/comments.docx")));
		const original = PackageArchive.open(source);
		const archive = PackageArchive.open(
			original.replace(
				"word/comments.xml",
				new Uint8Array([0xef, 0xbb, 0xbf, ...original.read("word/comments.xml")]),
			),
		);
		const snapshot = inspectDocx(archive, "comments");
		expect(snapshot.comments.map((comment) => ({ id: comment.id, author: comment.author }))).toEqual([
			{ id: "comment:rId6:0", author: "Michael Williamson" },
			{ id: "comment:rId6:2", author: "Michael Williamson" },
		]);
		const comment = snapshot.comments[0];
		const paragraph = comment.paragraphs[0];
		expect(paragraph.runs[0]).toMatchObject({ text: "", editable: false, blockedReason: "complex-run" });
		const run = paragraph.runs[1];
		expect(run).toMatchObject({ text: "A tachyon walks into a bar.", editable: true });
		const plan = planDocx(
			archive,
			snapshot,
			{
				protocolVersion: 1,
				operations: [
					{
						type: "replace_comment_text_run",
						target: { part: "comments", commentId: comment.id, paragraphId: paragraph.id, runId: run.id },
						precondition: {
							documentRevision: 1,
							expectedText: run.text,
							expectedTextSha256: run.anchor.textHash,
						},
						replacement: "Reviewed & approved.",
					},
				],
			},
			Date.now() + 10_000,
		);
		expect(plan.touchedParts).toEqual(["word/comments.xml"]);
		expect(plan.semanticDiff).toMatchObject([
			{ type: "comment-text", commentId: comment.id, runId: run.id, after: "Reviewed & approved." },
		]);
		const output = commitDocx(archive, snapshot, plan);
		const reopenedArchive = PackageArchive.open(output);
		expect(reopenedArchive.read("word/document.xml")).toEqual(archive.read("word/document.xml"));
		expect(new TextDecoder().decode(reopenedArchive.read("word/comments.xml"))).toContain("Reviewed &amp; approved.");
		const reopened = inspectDocx(reopenedArchive, "comments", 2);
		expect(reopened.comments[0].paragraphs[0].runs[1]).toMatchObject({ id: run.id, text: "Reviewed & approved." });
	});

	it("edits bold and italic while preserving unrelated run properties", () => {
		const document =
			'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr data="keep"><w:rStyle w:val="Body"/><w:color w:val="FF0000"/><w:b/></w:rPr><w:t>Styled</w:t></w:r></w:p></w:body></w:document>';
		const archive = PackageArchive.open(fixtureWithMain(document));
		const snapshot = inspectDocx(archive, "style");
		const run = snapshot.paragraphs[0].runs[0];
		const plan = planDocx(
			archive,
			snapshot,
			{
				protocolVersion: 1,
				operations: [
					{
						type: "set_text_run_style",
						target: { part: "document", paragraphId: "p-0", runId: run.id },
						precondition: {
							documentRevision: 1,
							expectedText: "Styled",
							expectedTextSha256: run.anchor.textHash,
							expectedProperties: { bold: true, italic: false, styleId: "Body" },
						},
						replacement: { bold: false, italic: true },
					},
				],
			},
			Date.now() + 10_000,
		);
		expect(plan.touchedRuns).toEqual([run.id]);
		expect(plan.patchManifest).toMatchObject([{ kind: "run_style" }]);
		expect(plan.semanticDiff).toEqual([
			{
				type: "run-style",
				runId: run.id,
				before: { bold: true, italic: false, styleId: "Body" },
				after: { bold: false, italic: true, styleId: "Body" },
			},
		]);
		const output = commitDocx(archive, snapshot, plan);
		const xml = new TextDecoder().decode(PackageArchive.open(output).read("word/document.xml"));
		expect(xml).toContain(
			'<w:rPr data="keep"><w:rStyle w:val="Body"/><w:color w:val="FF0000"/><w:b w:val="0"/><w:i w:val="1"/></w:rPr>',
		);
		expect(inspectDocx(PackageArchive.open(output), "style", 2).paragraphs[0].runs[0].properties).toEqual({
			bold: false,
			italic: true,
			styleId: "Body",
		});
	});

	it("adds run properties for strict and self-closing property nodes and rejects ambiguous styles", () => {
		for (const rPr of ["", "<s:rPr/>"]) {
			const document = `<s:document xmlns:s="http://purl.oclc.org/ooxml/wordprocessingml/main"><s:body><s:p><s:r>${rPr}<s:t>x</s:t></s:r></s:p></s:body></s:document>`;
			const archive = PackageArchive.open(fixtureWithMain(document));
			const snapshot = inspectDocx(archive, `strict-style-${rPr.length}`);
			const run = snapshot.paragraphs[0].runs[0];
			const plan = planDocx(
				archive,
				snapshot,
				{
					protocolVersion: 1,
					operations: [
						{
							type: "set_text_run_style",
							target: { part: "document", paragraphId: "p-0", runId: run.id },
							precondition: {
								documentRevision: 1,
								expectedText: "x",
								expectedTextSha256: run.anchor.textHash,
								expectedProperties: { bold: false, italic: false },
							},
							replacement: { bold: true },
						},
					],
				},
				Date.now() + 10_000,
			);
			const output = commitDocx(archive, snapshot, plan);
			expect(new TextDecoder().decode(PackageArchive.open(output).read("word/document.xml"))).toContain(
				'<s:rPr><s:b s:val="1"/></s:rPr>',
			);
		}
		for (const property of ["<w:b/><w:b/>", '<w:i custom="keep"/>']) {
			const ambiguous = PackageArchive.open(
				fixtureWithMain(
					`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr>${property}</w:rPr><w:t>x</w:t></w:r></w:p></w:body></w:document>`,
				),
			);
			expect(inspectDocx(ambiguous, `ambiguous-${property.length}`).paragraphs[0].runs[0]).toMatchObject({
				editable: false,
				blockedReason: "invalid-run-property",
			});
		}
	});

	it("rejects expired and conflicting plans", () => {
		const archive = PackageArchive.open(fixture());
		const snapshot = inspectDocx(archive, "doc-1");
		const run = snapshot.paragraphs[0].runs[0];
		const op = {
			type: "replace_text_run",
			target: { part: "document" as const, paragraphId: "p-0", runId: "r-0-0" },
			precondition: { documentRevision: 1, expectedText: "Hello", expectedTextSha256: run.anchor.textHash },
			replacement: "x",
		};
		expect(() =>
			planDocx(archive, snapshot, { protocolVersion: 1, operations: [op, op] }, Date.now() + 1000),
		).toThrow();
		expect(() => planDocx(archive, snapshot, { protocolVersion: 1, operations: [] }, Date.now() - 1)).toThrow();
	});
	it("maps surrogate pairs and rewrites self-closing text", () => {
		for (const value of ["😀before", "in😀side", "after😀"]) {
			const document = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${value}</w:t></w:r></w:p></w:body></w:document>`;
			const archive = PackageArchive.open(fixtureWithMain(document));
			const snapshot = inspectDocx(archive, "emoji");
			const run = snapshot.paragraphs[0].runs[0];
			const plan = planDocx(
				archive,
				snapshot,
				{
					protocolVersion: 1,
					operations: [
						{
							type: "replace_text_run",
							target: { part: "document", paragraphId: "p-0", runId: "r-0-0" },
							precondition: {
								documentRevision: 1,
								expectedText: value,
								expectedTextSha256: sha256Hex(new TextEncoder().encode(value)),
							},
							replacement: "替换😀",
						},
					],
				},
				Date.now() + 1000,
			);
			const result = PackageArchive.open(commitDocx(archive, snapshot, plan));
			expect(inspectDocx(result, "emoji", 2).paragraphs[0].runs[0].text).toBe("替换😀");
			expect(plan.patchManifest[0].start).toBe(run.anchor.start);
		}
		const empty = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r w:rsidR="x"><w:t/></w:r></w:p></w:body></w:document>`;
		const archive = PackageArchive.open(fixtureWithMain(empty));
		const snapshot = inspectDocx(archive, "empty");
		const plan = planDocx(
			archive,
			snapshot,
			{
				protocolVersion: 1,
				operations: [
					{
						type: "replace_text_run",
						target: { part: "document", paragraphId: "p-0", runId: "r-0-0" },
						precondition: {
							documentRevision: 1,
							expectedText: "",
							expectedTextSha256: sha256Hex(new TextEncoder().encode("")),
						},
						replacement: "text",
					},
				],
			},
			Date.now() + 1000,
		);
		expect(
			new TextDecoder().decode(PackageArchive.open(commitDocx(archive, snapshot, plan)).read("word/document.xml")),
		).toContain("<w:t>text</w:t>");
	});
	it("uses direct rStyle and rejects blocked paragraph operations", () => {
		const document = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:rStyle w:val="Heading1"/><w:b w:val="false"/><w:i/></w:rPr><w:t>x</w:t></w:r><w:tbl/></w:p></w:body></w:document>`;
		const archive = PackageArchive.open(fixtureWithMain(document));
		const snapshot = inspectDocx(archive, "style");
		expect(snapshot.paragraphs[0].editable).toBe(false);
		expect(snapshot.paragraphs[0].runs[0].properties).toEqual({ styleId: "Heading1", bold: false, italic: true });
		expect(snapshot.warnings[0].code).toBe("BLOCKED_CONTENT");
		expect(() =>
			validateDocumentOperationEnvelope({
				protocolVersion: 1,
				operations: [
					{
						type: "replace_text_run",
						target: { part: "document", paragraphId: "p", runId: "r", extra: true },
						precondition: {
							documentRevision: 1,
							expectedText: "",
							expectedTextSha256: sha256Hex(new TextEncoder().encode("")),
						},
						replacement: "",
					},
				],
			}),
		).toThrow();
	});
	it("commits ordered multi-op exactly once and rejects derived-field tamper", () => {
		const archive = PackageArchive.open(fixtureWithMain(multiMain));
		const snapshot = inspectDocx(archive, "multi");
		const operations = snapshot.paragraphs[0].runs.map((run) => ({
			type: "replace_text_run" as const,
			target: { part: "document" as const, paragraphId: "p-0", runId: run.id },
			precondition: { documentRevision: 1, expectedText: run.text, expectedTextSha256: run.anchor.textHash },
			replacement: `${run.text}!`,
		}));
		const plan = planDocx(archive, snapshot, { protocolVersion: 1, operations }, Date.now() + 10_000);
		expect(plan.patchManifest.map((patch) => patch.start)).toEqual(
			[...plan.patchManifest].sort((left, right) => left.start - right.start).map((patch) => patch.start),
		);
		const output = commitDocx(archive, snapshot, plan);
		const reopened = inspectDocx(PackageArchive.open(output), "multi", plan.resultingRevision);
		expect(reopened.paragraphs[0].runs.map((run) => run.text)).toEqual(["One!", "Two!"]);
		for (const field of [
			"documentId",
			"baseRevision",
			"resultingRevision",
			"sourceSha256",
			"semanticDiff",
			"touchedRuns",
			"touchedParagraphs",
			"touchedParts",
			"patchManifest",
			"envelope",
			"warnings",
			"expiresAt",
		] as const) {
			const values = {
				documentId: "other",
				baseRevision: 2,
				resultingRevision: 99,
				sourceSha256: "0".repeat(64),
				semanticDiff: [],
				touchedRuns: [],
				touchedParagraphs: ["p-x"],
				touchedParts: [],
				patchManifest: [],
				envelope: { protocolVersion: 1, operations: [] },
				warnings: [{ code: "tampered", part: "word/document.xml", message: "tampered" }],
				expiresAt: plan.expiresAt + 1,
			};
			const altered = { ...plan, [field]: values[field] };
			expect(() => commitDocx(archive, snapshot, altered)).toThrow();
		}
		expect(() => commitDocx(archive, snapshot, { ...plan, planSha256: "0".repeat(64) })).toThrow();
	});

	it("replaces a range across runs and preserves the surrounding text and run styles", () => {
		const styled =
			'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>One😀</w:t></w:r><w:r><w:t>Middle</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>Two</w:t></w:r></w:p></w:body></w:document>';
		const archive = PackageArchive.open(fixtureWithMain(styled));
		const snapshot = inspectDocx(archive, "range");
		const runs = snapshot.paragraphs[0].runs;
		const expectedText = "ne😀MiddleTw";
		const plan = planDocx(
			archive,
			snapshot,
			{
				protocolVersion: 1,
				operations: [
					{
						type: "replace_text_range",
						target: {
							part: "document",
							paragraphId: "p-0",
							start: { runId: runs[0].id, offset: 1 },
							end: { runId: runs[2].id, offset: 2 },
						},
						precondition: {
							documentRevision: 1,
							expectedText,
							expectedTextSha256: sha256Hex(new TextEncoder().encode(expectedText)),
						},
						replacement: " & ",
					},
				],
			},
			Date.now() + 10_000,
		);
		expect(plan.touchedRuns).toEqual(runs.map((run) => run.id));
		expect(plan.patchManifest).toHaveLength(3);
		expect(plan.patchManifest.every((patch) => patch.kind === "text_range")).toBe(true);
		expect(plan.semanticDiff).toEqual([
			{ runId: runs[0].id, before: "One😀", after: "O & " },
			{ runId: runs[1].id, before: "Middle", after: "" },
			{ runId: runs[2].id, before: "Two", after: "o" },
		]);
		const output = commitDocx(archive, snapshot, plan);
		const reopened = inspectDocx(PackageArchive.open(output), "range", 2);
		expect(reopened.paragraphs[0].runs.map((run) => run.text)).toEqual(["O & ", "", "o"]);
		expect(reopened.paragraphs[0].runs.map((run) => run.properties)).toEqual([
			{ bold: true, italic: false, styleId: undefined },
			{ bold: false, italic: false, styleId: undefined },
			{ bold: false, italic: true, styleId: undefined },
		]);
		const xml = new TextDecoder().decode(PackageArchive.open(output).read("word/document.xml"));
		expect(xml).toContain("O &amp; ");
	});

	it("inserts and deletes direct body paragraphs with exact anchors", () => {
		const document =
			'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>A</w:t></w:r></w:p><w:p><w:r><w:t>B</w:t></w:r></w:p><w:p><w:r><w:t>C</w:t></w:r></w:p><w:sectPr/></w:body></w:document>';
		const archive = PackageArchive.open(fixtureWithMain(document));
		const snapshot = inspectDocx(archive, "paragraphs");
		const [first, second] = snapshot.paragraphs;
		const plan = planDocx(
			archive,
			snapshot,
			{
				protocolVersion: 1,
				operations: [
					{
						type: "insert_paragraph_after",
						target: { part: "document", paragraphId: first.id },
						precondition: {
							documentRevision: 1,
							expectedText: "A",
							expectedTextSha256: first.anchor.textHash,
						},
						replacement: " 新 & 文本 ",
					},
					{
						type: "delete_paragraph",
						target: { part: "document", paragraphId: second.id },
						precondition: {
							documentRevision: 1,
							expectedText: "B",
							expectedTextSha256: second.anchor.textHash,
						},
					},
				],
			},
			Date.now() + 10_000,
		);
		expect(plan.touchedParagraphs).toEqual([first.id, second.id]);
		expect(plan.touchedRuns).toEqual(second.runs.map((run) => run.id));
		expect(plan.patchManifest.map((patch) => patch.kind)).toEqual(["paragraph_insert", "paragraph_delete"]);
		expect(plan.semanticDiff).toEqual([
			{ type: "paragraph", paragraphId: first.id, change: "insert", before: "", after: " 新 & 文本 " },
			{ type: "paragraph", paragraphId: second.id, change: "delete", before: "B", after: "" },
		]);
		const output = commitDocx(archive, snapshot, plan);
		const reopened = inspectDocx(PackageArchive.open(output), "paragraphs", 2);
		expect(reopened.paragraphs.map((paragraph) => paragraph.runs.map((run) => run.text).join(""))).toEqual([
			"A",
			" 新 & 文本 ",
			"C",
		]);
		const xml = new TextDecoder().decode(PackageArchive.open(output).read("word/document.xml"));
		expect(xml).toContain('<w:t xml:space="preserve"> 新 &amp; 文本 </w:t>');
		expect(xml).not.toContain("<w:t>B</w:t>");
	});

	it("rejects stale, malformed, blocked, and conflicting paragraph operations", () => {
		const archive = PackageArchive.open(fixtureWithMain(multiMain));
		const snapshot = inspectDocx(archive, "paragraph-guards");
		const paragraph = snapshot.paragraphs[0];
		const insert = {
			type: "insert_paragraph_after" as const,
			target: { part: "document" as const, paragraphId: paragraph.id },
			precondition: {
				documentRevision: 1,
				expectedText: "OneTwo",
				expectedTextSha256: paragraph.anchor.textHash,
			},
			replacement: "new",
		};
		for (const invalid of [
			{ ...insert, extra: true },
			{ ...insert, target: { ...insert.target, extra: true } },
			{ ...insert, precondition: { ...insert.precondition, expectedText: "stale" } },
			{ ...insert, replacement: "\0" },
			{
				type: "delete_paragraph",
				target: insert.target,
				precondition: insert.precondition,
				replacement: "not-allowed",
			},
		])
			expect(() =>
				planDocx(archive, snapshot, { protocolVersion: 1, operations: [invalid] }, Date.now() + 1_000),
			).toThrow();
		expect(() =>
			planDocx(
				archive,
				snapshot,
				{
					protocolVersion: 1,
					operations: [
						insert,
						{
							type: "replace_text_run",
							target: { part: "document", paragraphId: paragraph.id, runId: paragraph.runs[0].id },
							precondition: {
								documentRevision: 1,
								expectedText: "One",
								expectedTextSha256: paragraph.runs[0].anchor.textHash,
							},
							replacement: "changed",
						},
					],
				},
				Date.now() + 1_000,
			),
		).toThrow();
		const blockedArchive = PackageArchive.open(
			fixtureWithMain(
				'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:hyperlink><w:r><w:t>x</w:t></w:r></w:hyperlink></w:p></w:body></w:document>',
			),
		);
		const blocked = inspectDocx(blockedArchive, "blocked-paragraph");
		expect(() =>
			planDocx(
				blockedArchive,
				blocked,
				{
					protocolVersion: 1,
					operations: [
						{
							type: "delete_paragraph",
							target: { part: "document", paragraphId: blocked.paragraphs[0].id },
							precondition: {
								documentRevision: 1,
								expectedText: "",
								expectedTextSha256: blocked.paragraphs[0].anchor.textHash,
							},
						},
					],
				},
				Date.now() + 1_000,
			),
		).toThrow();
	});

	it("rejects a cross-run range before expanding more than the touched-run budget", () => {
		const runs = Array.from({ length: TRANSACTION_BUDGETS.maxTouchedRuns + 1 }, () => "<w:r><w:t>x</w:t></w:r>").join(
			"",
		);
		const document = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>${runs}</w:p></w:body></w:document>`;
		const archive = PackageArchive.open(fixtureWithMain(document));
		const snapshot = inspectDocx(archive, "range-budget");
		const paragraphRuns = snapshot.paragraphs[0].runs;
		const expectedText = "x".repeat(paragraphRuns.length);
		expectCode(
			() =>
				planDocx(
					archive,
					snapshot,
					{
						protocolVersion: 1,
						operations: [
							{
								type: "replace_text_range",
								target: {
									part: "document",
									paragraphId: "p-0",
									start: { runId: paragraphRuns[0].id, offset: 0 },
									end: { runId: paragraphRuns.at(-1)!.id, offset: 1 },
								},
								precondition: {
									documentRevision: 1,
									expectedText,
									expectedTextSha256: sha256Hex(new TextEncoder().encode(expectedText)),
								},
								replacement: "bounded",
							},
						],
					},
					Date.now() + 1_000,
				),
			"VALIDATION_FAILED",
		);
	});

	it("fails closed for invalid cross-run range boundaries and plan tampering", () => {
		const archive = PackageArchive.open(fixtureWithMain(multiMain));
		const snapshot = inspectDocx(archive, "range-boundary");
		const [first, second] = snapshot.paragraphs[0].runs;
		const operation = {
			type: "replace_text_range" as const,
			target: {
				part: "document" as const,
				paragraphId: "p-0",
				start: { runId: first.id, offset: 1 },
				end: { runId: second.id, offset: 2 },
			},
			precondition: {
				documentRevision: 1,
				expectedText: "neTw",
				expectedTextSha256: sha256Hex(new TextEncoder().encode("neTw")),
			},
			replacement: "x",
		};
		const invalid = [
			{ ...operation, target: { ...operation.target, start: { ...operation.target.start, offset: -1 } } },
			{
				...operation,
				target: { ...operation.target, start: { ...operation.target.start, offset: first.text.length } },
			},
			{ ...operation, target: { ...operation.target, end: { ...operation.target.end, offset: 0 } } },
			{ ...operation, target: { ...operation.target, start: { runId: second.id, offset: 0 } } },
			{ ...operation, target: { ...operation.target, end: { runId: first.id, offset: 1 } } },
			{ ...operation, target: { ...operation.target, extra: true } },
			{ ...operation, target: { ...operation.target, start: { ...operation.target.start, extra: true } } },
		];
		for (const value of invalid)
			expect(() =>
				planDocx(archive, snapshot, { protocolVersion: 1, operations: [value] }, Date.now() + 1000),
			).toThrow();
		for (const target of [
			{ ...operation.target, start: { ...operation.target.start, runId: "" } },
			{ ...operation.target, end: { ...operation.target.end, runId: "" } },
		])
			expect(() =>
				validateDocumentOperationEnvelope({
					protocolVersion: 1,
					operations: [{ ...operation, target }],
				}),
			).toThrow();
		const emojiArchive = PackageArchive.open(fixtureWithMain(multiMain.replace("One", "A😀B")));
		const emojiSnapshot = inspectDocx(emojiArchive, "surrogate");
		const emojiRuns = emojiSnapshot.paragraphs[0].runs;
		const splitSurrogate = {
			...operation,
			target: {
				...operation.target,
				start: { runId: emojiRuns[0].id, offset: 2 },
				end: { runId: emojiRuns[1].id, offset: 1 },
			},
			precondition: {
				...operation.precondition,
				expectedText: "\ude00BT",
				expectedTextSha256: sha256Hex(new TextEncoder().encode("\ude00BT")),
			},
		};
		expect(() =>
			planDocx(emojiArchive, emojiSnapshot, { protocolVersion: 1, operations: [splitSurrogate] }, Date.now() + 1000),
		).toThrow();
		const blockedDocument =
			'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>One</w:t></w:r><w:bookmarkStart w:id="0" w:name="mark"/><w:r><w:t>Two</w:t></w:r></w:p></w:body></w:document>';
		const blockedArchive = PackageArchive.open(fixtureWithMain(blockedDocument));
		const blockedSnapshot = inspectDocx(blockedArchive, "blocked-range");
		expectCode(
			() =>
				planDocx(
					blockedArchive,
					blockedSnapshot,
					{ protocolVersion: 1, operations: [operation] },
					Date.now() + 1000,
				),
			"OPERATION_BLOCKED",
		);
		const plan = planDocx(archive, snapshot, { protocolVersion: 1, operations: [operation] }, Date.now() + 1000);
		expect(() =>
			commitDocx(archive, snapshot, {
				...plan,
				patchManifest: plan.patchManifest.map((patch) => ({ ...patch, kind: "text_run" as const })),
			}),
		).toThrow();
	});

	it("rejects transaction schema boundaries and invalid snapshot identity", () => {
		const archive = PackageArchive.open(fixture());
		const snapshot = inspectDocx(archive, "schema");
		const run = snapshot.paragraphs[0].runs[0];
		const valid = {
			type: "replace_text_run" as const,
			target: { part: "document" as const, paragraphId: "p-0", runId: run.id },
			precondition: { documentRevision: 1, expectedText: "Hello", expectedTextSha256: run.anchor.textHash },
			replacement: "ok",
		};
		const invalid: unknown[] = [
			undefined,
			{ protocolVersion: 2, operations: [] },
			{ protocolVersion: 1, operations: {} },
			{ protocolVersion: 1, operations: [], extra: true },
			{ protocolVersion: 1, operations: [valid, ...Array(100).fill(valid)] },
			{ protocolVersion: 1, operations: [{ ...valid, type: "other" }] },
			{ protocolVersion: 1, operations: [{ ...valid, target: { ...valid.target, part: "header" } }] },
			{ protocolVersion: 1, operations: [{ ...valid, extra: true }] },
			{ protocolVersion: 1, operations: [null] },
			{ protocolVersion: 1, operations: [{ ...valid, target: null }] },
			{ protocolVersion: 1, operations: [{ ...valid, target: { ...valid.target, paragraphId: 1 } }] },
			{ protocolVersion: 1, operations: [{ ...valid, target: { ...valid.target, runId: 1 } }] },
			{ protocolVersion: 1, operations: [{ ...valid, replacement: 1 }] },
			{ protocolVersion: 1, operations: [{ ...valid, precondition: null }] },
			{ protocolVersion: 1, operations: [{ ...valid, precondition: { ...valid.precondition, expectedText: 1 } }] },
			{
				protocolVersion: 1,
				operations: [{ ...valid, precondition: { ...valid.precondition, expectedTextSha256: 1 } }],
			},
			{ protocolVersion: 1, operations: [{ ...valid, target: { ...valid.target, paragraphId: "\u0001" } }] },
			{ protocolVersion: 1, operations: [{ ...valid, target: { ...valid.target, runId: "\u0001" } }] },
			{
				protocolVersion: 1,
				operations: [{ ...valid, precondition: { ...valid.precondition, expectedText: "x".repeat(100_001) } }],
			},
			{ protocolVersion: 1, operations: [{ ...valid, replacement: "x".repeat(100_001) }] },

			{ protocolVersion: 1, operations: [{ ...valid, target: { ...valid.target, paragraphId: "\0" } }] },
			{ protocolVersion: 1, operations: [{ ...valid, target: { ...valid.target, runId: "a".repeat(257) } }] },
			{ protocolVersion: 1, operations: [{ ...valid, replacement: "\0" }] },
			{
				protocolVersion: 1,
				operations: [{ ...valid, precondition: { ...valid.precondition, documentRevision: 1.5 } }],
			},
			{
				protocolVersion: 1,
				operations: [{ ...valid, precondition: { ...valid.precondition, expectedTextSha256: "0".repeat(64) } }],
			},
		];
		for (const value of invalid) expect(() => validateDocumentOperationEnvelope(value)).toThrow();
		for (const value of ["", "x".repeat(257)]) expect(() => inspectDocx(archive, value)).toThrow();
		for (const revision of [0, 1.5, Number.POSITIVE_INFINITY])
			expect(() => inspectDocx(archive, "schema", revision)).toThrow();
		for (const value of [
			{ protocolVersion: 1, operations: [undefined] },
			{ protocolVersion: 1, operations: [Number.NaN] },
			{ protocolVersion: 1, operations: [Symbol("invalid")] },
			{ protocolVersion: 1, operations: [new Date()] },
		])
			expect(() => validateDocumentOperationEnvelope(value)).toThrow();
		const noRun = {
			protocolVersion: 1,
			operations: [{ ...valid, target: { ...valid.target, runId: "missing" } }],
		};
		expect(() => planDocx(archive, snapshot, noRun, Date.now() + 1000)).toThrow();
		const noOpPlan = planDocx(archive, snapshot, { protocolVersion: 1, operations: [] }, Date.now() + 1000);
		expect(() => commitDocx(archive, snapshot, { ...noOpPlan, expiresAt: Number.NaN })).toThrow();
		const badSnapshot = {
			...snapshot,
			paragraphs: snapshot.paragraphs.map((paragraph) => ({
				...paragraph,
				runs: paragraph.runs.map((item) => ({
					...item,
					anchor: { ...item.anchor, textStart: Number.MAX_SAFE_INTEGER },
				})),
			})),
		};
		expect(() =>
			planDocx(archive, badSnapshot, { protocolVersion: 1, operations: [valid] }, Date.now() + 1000),
		).toThrow();

		expect(() =>
			planDocx(archive, snapshot, { protocolVersion: 1, operations: [] }, Date.now() + 86_400_001),
		).toThrow();
		for (const document of [
			`text${main}`,
			`${main}${main}`,
			main.replace("<w:body>", "<w:body><w:p><w:r><w:t>"),
			main.replace('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"', 'xmlns:w="urn:evil"'),
		])
			expect(() => inspectDocx(PackageArchive.open(fixtureWithMain(document)), "malformed")).toThrow();
	});

	it("keeps no-op bytes identical and rejects non-finite, shared, and sparse schema values", () => {
		const archive = PackageArchive.open(fixture());
		const snapshot = inspectDocx(archive, "noop");
		const plan = planDocx(archive, snapshot, { protocolVersion: 1, operations: [] }, Date.now() + 10_000);
		expect(commitDocx(archive, snapshot, plan)).toEqual(archive.serialize());
		const shared = { protocolVersion: 1, operations: [] as never[] };
		(shared as unknown as { extra: unknown }).extra = shared.operations;
		for (const value of [
			{ protocolVersion: 1, operations: [], value: Number.NaN },
			{ protocolVersion: 1, operations: [], value: Number.POSITIVE_INFINITY },
			shared,
		])
			expect(() => validateDocumentOperationEnvelope(value)).toThrow();
		const sparse = [] as unknown[];
		sparse.length = 1;
		expect(() => validateDocumentOperationEnvelope({ protocolVersion: 1, operations: sparse })).toThrow();
	});

	it("fails closed for XML limits and rejects DTD or non-declaration PI", () => {
		const nested = `${"<w:x>".repeat(257)}text${"</w:x>".repeat(257)}`;
		expectCode(
			() =>
				inspectDocx(PackageArchive.open(fixtureWithMain(main.replace("<w:body>", `<w:body>${nested}`))), "depth"),
			"XML_INVALID",
		);
		const many = "<w:x/>".repeat(200_001);
		expectCode(
			() =>
				inspectDocx(PackageArchive.open(fixtureWithMain(main.replace("<w:body>", `<w:body>${many}`), 0)), "nodes"),
			"XML_INVALID",
		);
		for (const [xml, code] of [
			[`<!DOCTYPE w:document>${main}`, "XML_DTD_FORBIDDEN"],
			[`<?evil nope?>${main}`, "XML_PI_FORBIDDEN"],
		] as const)
			expectCode(() => inspectDocx(PackageArchive.open(fixtureWithMain(xml)), "xml"), code);
		const start = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>';
		const end = "</w:body></w:document>";
		const exact = `${start}${"a".repeat(16 * 1024 * 1024 - new TextEncoder().encode(start + end).length)}${end}`;
		expect(() => inspectDocx(PackageArchive.open(fixtureWithMain(exact, 0)), "exact")).not.toThrow();
		expectCode(() => inspectDocx(PackageArchive.open(fixtureWithMain(`${exact}a`, 0)), "large"), "XML_TOO_LARGE");
	}, 30_000);

	it("blocks XML constructs and parses complete OnOff values", () => {
		const ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
		for (const markup of ["<w:t><![CDATA[x]]></w:t>", "<w:t>x<!--blocked--></w:t>", "<w:foo><w:t>x</w:t></w:foo>"]) {
			const xml = `<w:document xmlns:w="${ns}"><w:body><w:p><w:r>${markup}</w:r></w:p></w:body></w:document>`;
			expect(inspectDocx(PackageArchive.open(fixtureWithMain(xml)), "blocked").paragraphs[0].editable).toBe(false);
		}
		for (const [value, expected] of [
			["false", false],
			["0", false],
			["off", false],
			["no", false],
			["true", true],
			["1", true],
			["on", true],
			["yes", true],
			["", true],
		] as const) {
			const xml = `<w:document xmlns:w="${ns}"><w:body><w:p><w:r><w:rPr><w:b${value === "" ? "" : ` w:val="${value}"`}/></w:rPr><w:t>x</w:t></w:r></w:p></w:body></w:document>`;
			expect(
				inspectDocx(PackageArchive.open(fixtureWithMain(xml)), "onoff").paragraphs[0].runs[0].properties.bold,
			).toBe(expected);
		}
		const invalid = `<w:document xmlns:w="${ns}"><w:body><w:p><w:r><w:rPr><w:b w:val="maybe"/></w:rPr><w:t>x</w:t></w:r></w:p></w:body></w:document>`;
		expect(inspectDocx(PackageArchive.open(fixtureWithMain(invalid)), "invalid").paragraphs[0].runs[0].editable).toBe(
			false,
		);
	});

	it("preserves CR, CRLF, tab, and LF replacement semantics", () => {
		for (const replacement of ["\r", "\r\n", "\t", "\n"]) {
			const archive = PackageArchive.open(fixture());
			const snapshot = inspectDocx(archive, "line-endings");
			const run = snapshot.paragraphs[0].runs[0];
			const plan = planDocx(
				archive,
				snapshot,
				{
					protocolVersion: 1,
					operations: [
						{
							type: "replace_text_run",
							target: { part: "document", paragraphId: "p-0", runId: run.id },
							precondition: {
								documentRevision: 1,
								expectedText: run.text,
								expectedTextSha256: run.anchor.textHash,
							},
							replacement,
						},
					],
				},
				Date.now() + 1000,
			);
			const output = PackageArchive.open(commitDocx(archive, snapshot, plan));
			expect(inspectDocx(output, "line-endings", 2).paragraphs[0].runs[0].text).toBe(replacement);
			if (replacement.includes("\r"))
				expect(new TextDecoder().decode(output.read("word/document.xml"))).toContain("&#xD;");
		}
	});

	it("reports stable typed blocked reasons for unsupported boundaries", () => {
		const ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
		const cases: ReadonlyArray<readonly [string, string, string]> = [
			["bookmark", '<w:r><w:t>x</w:t></w:r><w:bookmarkStart w:id="0" w:name="mark"/>', "bookmark-boundary"],
			["field", '<w:r><w:fldChar w:fldCharType="begin"/><w:t>x</w:t></w:r>', "field-boundary"],
			["revision", "<w:ins><w:r><w:t>x</w:t></w:r></w:ins>", "tracked-revision"],
			["content-control", "<w:sdt><w:sdtContent><w:r><w:t>x</w:t></w:r></w:sdtContent></w:sdt>", "content-control"],
			["hyperlink", '<w:hyperlink w:anchor="x"><w:r><w:t>x</w:t></w:r></w:hyperlink>', "hyperlink-boundary"],
			["drawing", "<w:r><w:drawing/><w:t>x</w:t></w:r>", "drawing-content"],
			["textbox", "<w:r><w:txbxContent/><w:t>x</w:t></w:r>", "textbox-content"],
			["foreign", '<x:item xmlns:x="urn:evil"/><w:r><w:t>x</w:t></w:r>', "foreign-namespace"],
			["on-off", '<w:r><w:rPr><w:b w:val="maybe"/></w:rPr><w:t>x</w:t></w:r>', "invalid-run-property"],
		];
		for (const [name, markup, reason] of cases) {
			const document = `<w:document xmlns:w="${ns}"><w:body><w:p>${markup}</w:p></w:body></w:document>`;
			const paragraph = inspectDocx(PackageArchive.open(fixtureWithMain(document)), name).paragraphs[0];
			expect(paragraph.blockedReason).toBe(reason);
			for (const run of paragraph.runs) expect(run.blockedReason).toBe(reason);
		}
	});

	it("preserves BOM byte offsets and exact multilingual replacement boundaries", () => {
		const value = " old😀́中文 ";
		const replacement = " new😀́中文 ";
		const document = `\ufeff<?xml version="1.0" encoding="UTF-8"?>\r\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">\r\n<w:body>\r\n<w:p>\r\n<w:r><w:t>${value}</w:t></w:r>\r\n</w:p>\r\n</w:body>\r\n</w:document>`;
		const archive = PackageArchive.open(fixtureWithMain(document));
		const source = archive.read("word/document.xml");
		expect(source.slice(0, 3)).toEqual(Uint8Array.from([0xef, 0xbb, 0xbf]));
		const snapshot = inspectDocx(archive, "bom");
		const run = snapshot.paragraphs[0].runs[0];
		expect(run.text).toBe(value);
		expect(run.anchor.start).toBe(
			3 +
				new TextEncoder().encode(
					'<?xml version="1.0" encoding="UTF-8"?>\r\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">\r\n<w:body>\r\n<w:p>\r\n',
				).length,
		);
		const plan = planDocx(
			archive,
			snapshot,
			{
				protocolVersion: 1,
				operations: [
					{
						type: "replace_text_run",
						target: { part: "document", paragraphId: "p-0", runId: run.id },
						precondition: {
							documentRevision: 1,
							expectedText: value,
							expectedTextSha256: sha256Hex(new TextEncoder().encode(value)),
						},
						replacement,
					},
				],
			},
			Date.now() + 1000,
		);
		const patch = plan.patchManifest[0];
		expect(patch.preimageSha256).toBe(sha256Hex(source.slice(patch.start, patch.end)));
		const output = commitDocx(archive, snapshot, plan);
		const reopenedArchive = PackageArchive.open(output);
		const reopened = inspectDocx(reopenedArchive, "bom", 2);
		expect(reopened.paragraphs[0].runs[0].text).toBe(replacement);
		const result = reopenedArchive.read("word/document.xml");
		expect(result.slice(0, patch.start)).toEqual(source.slice(0, patch.start));
		const patchReplacement = Uint8Array.from(atob(patch.replacementBase64), (character) => character.charCodeAt(0));
		expect(result.slice(patch.start + patchReplacement.length)).toEqual(source.slice(patch.end));
		expect(result.slice(0, 3)).toEqual(Uint8Array.from([0xef, 0xbb, 0xbf]));
	});

	it("uses body identity and preserves xml:space patch boundaries", () => {
		const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="urn:evil"><w:body>\r\n<a:body><a:p><a:r><a:t>evil</a:t></a:r></a:p></a:body><w:p><w:r xml:space="preserve"><w:t xml:space='default'> CJḰ😀 </w:t></w:r></w:p></w:body></w:document>`;
		const archive = PackageArchive.open(fixtureWithMain(xml));
		const snapshot = inspectDocx(archive, "identity");
		expect(snapshot.paragraphs).toHaveLength(1);
		const run = snapshot.paragraphs[0].runs[0];
		const plan = planDocx(
			archive,
			snapshot,
			{
				protocolVersion: 1,
				operations: [
					{
						type: "replace_text_run",
						target: { part: "document", paragraphId: "p-0", runId: run.id },
						precondition: {
							documentRevision: 1,
							expectedText: " CJḰ😀 ",
							expectedTextSha256: run.anchor.textHash,
						},
						replacement: " new ",
					},
				],
			},
			Date.now() + 1000,
		);
		const output = new TextDecoder().decode(
			PackageArchive.open(commitDocx(archive, snapshot, plan)).read("word/document.xml"),
		);
		expect(output).toContain('<w:r xml:space="preserve"><w:t xml:space="preserve"> new </w:t></w:r>');
	});

	it("accepts the optional document background and rejects other root child sequences", () => {
		for (const namespace of [
			"http://schemas.openxmlformats.org/wordprocessingml/2006/main",
			"http://purl.oclc.org/ooxml/wordprocessingml/main",
		]) {
			const document = `<w:document xmlns:w="${namespace}"><w:background w:color="FFFFFF"/><w:body><w:p><w:r><w:t>text</w:t></w:r></w:p></w:body></w:document>`;
			const snapshot = inspectDocx(PackageArchive.open(fixtureWithMain(document)), "background");
			expect(snapshot.paragraphs[0].runs[0].text).toBe("text");
			expect(snapshot.paragraphs[0].editable).toBe(true);
		}
		const namespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
		for (const children of [
			"<w:body/><w:background/>",
			"<w:background/><w:background/><w:body/>",
			"<w:unknown/><w:body/>",
		]) {
			expectCode(
				() =>
					inspectDocx(
						PackageArchive.open(fixtureWithMain(`<w:document xmlns:w="${namespace}">${children}</w:document>`)),
						"invalid-root-child",
					),
				"XML_INVALID",
			);
		}
	});

	it("accepts strict OOXML namespace through the transaction API", () => {
		const strict = "http://purl.oclc.org/ooxml/wordprocessingml/main";
		const document = `<w:document xmlns:w="${strict}"><w:body><w:p><w:r><w:t>strict</w:t></w:r></w:p></w:body></w:document>`;
		const archive = PackageArchive.open(fixtureWithMain(document));
		const snapshot = inspectDocx(archive, "strict");
		const run = snapshot.paragraphs[0].runs[0];
		const plan = planDocx(
			archive,
			snapshot,
			{
				protocolVersion: 1,
				operations: [
					{
						type: "replace_text_run",
						target: { part: "document", paragraphId: "p-0", runId: run.id },
						precondition: {
							documentRevision: 1,
							expectedText: "strict",
							expectedTextSha256: run.anchor.textHash,
						},
						replacement: "updated",
					},
				],
			},
			Date.now() + 1000,
		);
		expect(
			inspectDocx(PackageArchive.open(commitDocx(archive, snapshot, plan)), "strict", 2).paragraphs[0].runs[0].text,
		).toBe("updated");
	});

	it("rejects expired commits and a stale snapshot identity", () => {
		const archive = PackageArchive.open(fixture());
		const snapshot = inspectDocx(archive, "identity");
		const run = snapshot.paragraphs[0].runs[0];
		const plan = planDocx(
			archive,
			snapshot,
			{
				protocolVersion: 1,
				operations: [
					{
						type: "replace_text_run",
						target: { part: "document", paragraphId: "p-0", runId: run.id },
						precondition: {
							documentRevision: 1,
							expectedText: run.text,
							expectedTextSha256: run.anchor.textHash,
						},
						replacement: "changed",
					},
				],
			},
			Date.now() + 1000,
		);
		expectCode(() => commitDocx(archive, snapshot, plan, plan.expiresAt), "TRANSACTION_EXPIRED");
		expectCode(() => commitDocx(archive, { ...snapshot, mainPart: "word/header.xml" }, plan), "STALE_DOCUMENT");
	});

	it("blocks nested w:t markup and preserves source bytes", () => {
		const document = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>before<w:foo/>after</w:t></w:r></w:p></w:body></w:document>`;
		const archive = PackageArchive.open(fixtureWithMain(document));
		const source = archive.read("word/document.xml");
		const snapshot = inspectDocx(archive, "nested");
		const run = snapshot.paragraphs[0].runs[0];
		expect(run.editable).toBe(false);
		expect(run.blockedReason).toBe("complex-run");
		expect(() =>
			planDocx(archive, snapshot, { protocolVersion: 1, operations: [] }, Date.now() + 1000),
		).not.toThrow();
		expect(archive.read("word/document.xml")).toEqual(source);
	});

	it("rejects replacement before compression when the archive single-entry budget is exceeded", () => {
		const archive = PackageArchive.open(fixtureWithMain(main), { maxSingleUncompressedBytes: 4096 });
		expect(() => archive.replace("word/document.xml", new TextEncoder().encode("x".repeat(4097)))).toThrow();
	});

	it("rejects non-plain nested transaction values", () => {
		const valid = {
			protocolVersion: 1,
			operations: [
				{
					type: "replace_text_run" as const,
					target: { part: "document" as const, paragraphId: "p-0", runId: "r-0-0" },
					precondition: {
						documentRevision: 1,
						expectedText: "",
						expectedTextSha256: sha256Hex(new TextEncoder().encode("")),
					},
					replacement: "",
				},
			],
		};
		expect(() => validateDocumentOperationEnvelope({ ...valid, operations: [new Date()] })).toThrow();
		expect(() =>
			validateDocumentOperationEnvelope({ ...valid, operations: [{ ...valid.operations[0], target: new Date() }] }),
		).toThrow();
		expect(() =>
			validateDocumentOperationEnvelope({
				...valid,
				operations: [{ ...valid.operations[0], precondition: new Date() }],
			}),
		).toThrow();
	});
	it("rejects XML markup outside the document root and invalid plan identity", () => {
		for (const markup of ["<![CDATA[outside]]>", "<!--outside-->"]) {
			expectCode(
				() => inspectDocx(PackageArchive.open(fixtureWithMain(`${markup}${main}`)), "outside"),
				"XML_INVALID",
			);
		}
		const archive = PackageArchive.open(fixture());
		const snapshot = inspectDocx(archive, "identity-type");
		const plan = planDocx(archive, snapshot, { protocolVersion: 1, operations: [] }, Date.now() + 1000);
		expectCode(
			() => commitDocx(archive, snapshot, { ...plan, documentId: 42 } as unknown as typeof plan),
			"STALE_DOCUMENT",
		);
	});
});
