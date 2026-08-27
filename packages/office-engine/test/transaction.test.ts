import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
	commitDocx,
	inspectDocx,
	OfficeEngineError,
	PackageArchive,
	planDocx,
	sha256Hex,
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
