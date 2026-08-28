import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { assertXlsxCorpusAdmission } from "../scripts/corpus-admission.ts";
import { commitXlsx, inspectXlsx, OfficeEngineError, PackageArchive, planXlsx } from "../src/index.ts";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

function fixture(
	options: {
		readonly nested?: boolean;
		readonly strictPackage?: boolean;
		readonly bomWorksheet?: boolean;
		readonly secondWorksheet?: boolean;
	} = {},
): Uint8Array {
	const workbookPart = options.nested ? "xl/nested/workbook.xml" : "xl/workbook.xml";
	const workbookRelationshipsPart = options.nested
		? "xl/nested/_rels/workbook.xml.rels"
		: "xl/_rels/workbook.xml.rels";
	const worksheetTarget = options.nested ? "../worksheets/sheet1.xml" : "worksheets/sheet1.xml";
	const sharedStringsTarget = options.nested ? "../sharedStrings.xml" : "sharedStrings.xml";
	const packageNamespace = options.strictPackage
		? "http://purl.oclc.org/ooxml/package/relationships"
		: "http://schemas.openxmlformats.org/package/2006/relationships";
	const secondWorksheetContentType = options.secondWorksheet
		? '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
		: "";
	const secondSheet = options.secondWorksheet ? '<sheet name="Forecast" sheetId="2" r:id="rSheet2"/>' : "";
	const secondWorksheetRelationship = options.secondWorksheet
		? '<Relationship Id="rSheet2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
		: "";
	const worksheet =
		'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" s="2" t="s"><v>0</v></c><c r="B1"><v>42</v></c><c r="C1"><f>SUM(B1:B1)</f><v>42</v></c><c r="D1" t="s"><v>1</v></c><c r="E1" t="b"><v>1</v></c><c r="F1" t="b"><v>2</v></c><c r="G1" t="s"><v>99</v></c><c r="H1" t="e"><v>#REF!</v></c><c r="I1"/><c r="J1"><v>not-a-number</v></c></row></sheetData></worksheet>';
	return zipSync({
		"[Content_Types].xml": encode(
			`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${workbookPart}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>${secondWorksheetContentType}<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
		),
		"_rels/.rels": encode(
			`<Relationships xmlns="${packageNamespace}"><Relationship Id="root" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${workbookPart}"/></Relationships>`,
		),
		[workbookPart]: encode(
			`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Budget" sheetId="1" r:id="rSheet1"/>${secondSheet}</sheets></workbook>`,
		),
		[workbookRelationshipsPart]: encode(
			`<Relationships xmlns="${packageNamespace}"><Relationship Id="rSheet1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${worksheetTarget}"/>${secondWorksheetRelationship}<Relationship Id="rStrings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="${sharedStringsTarget}"/></Relationships>`,
		),
		"xl/sharedStrings.xml": encode(
			'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Revenue</t></si><si><r><t>Rich </t></r><r><t>text</t></r></si></sst>',
		),
		"xl/worksheets/sheet1.xml": encode(`${options.bomWorksheet ? "\uFEFF" : ""}${worksheet}`),
		...(options.secondWorksheet
			? {
					"xl/worksheets/sheet2.xml": encode(
						'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData></worksheet>',
					),
				}
			: {}),
		"docProps/custom.xml": encode("unchanged"),
	});
}

function replaceText(archive: PackageArchive, part: string, search: string, replacement: string): PackageArchive {
	const xml = new TextDecoder().decode(archive.read(part));
	return PackageArchive.open(archive.replace(part, encode(xml.replace(search, replacement))));
}

function operation(snapshot: ReturnType<typeof inspectXlsx>, address: string, replacement: string, sheetIndex = 0) {
	const sheet = snapshot.sheets[sheetIndex];
	const cell = sheet?.cells.find((item) => item.address === address);
	if (!sheet || !cell) throw new Error("fixture cell missing");
	return {
		type: "set_cell_value" as const,
		target: { sheetId: sheet.id, cellId: cell.id, address: cell.address },
		precondition: {
			documentRevision: snapshot.revision,
			expectedValue: cell.value,
			expectedValueSha256: cell.valueSha256,
		},
		replacement,
	};
}

describe("XLSX native transaction", () => {
	it("inspects stable cells and edits existing non-formula cells in one worksheet", () => {
		const source = PackageArchive.open(fixture());
		const snapshot = inspectXlsx(source, "xlsx-1");
		expect(snapshot.sheets).toHaveLength(1);
		expect(snapshot.sheets[0]).toMatchObject({ id: "sheet:rSheet1", relationshipId: "rSheet1", name: "Budget" });
		expect(
			snapshot.sheets[0]?.cells.map(({ id, value, editable, blockedReason }) => ({
				id,
				value,
				editable,
				blockedReason,
			})),
		).toEqual([
			{ id: "rSheet1:A1", value: "Revenue", editable: true, blockedReason: undefined },
			{ id: "rSheet1:B1", value: "42", editable: true, blockedReason: undefined },
			{ id: "rSheet1:C1", value: "42", editable: false, blockedReason: "formula" },
			{ id: "rSheet1:D1", value: "Rich text", editable: true, blockedReason: undefined },
			{ id: "rSheet1:E1", value: "TRUE", editable: true, blockedReason: undefined },
			{ id: "rSheet1:F1", value: "FALSE", editable: false, blockedReason: "unsupported-cell" },
			{ id: "rSheet1:G1", value: "", editable: false, blockedReason: "unsupported-cell" },
			{ id: "rSheet1:H1", value: "#REF!", editable: false, blockedReason: "unsupported-cell" },
			{ id: "rSheet1:I1", value: "", editable: true, blockedReason: undefined },
			{ id: "rSheet1:J1", value: "not-a-number", editable: false, blockedReason: "unsupported-cell" },
		]);

		const plan = planXlsx(
			source,
			snapshot,
			{
				protocolVersion: 1,
				operations: [operation(snapshot, "A1", "Net & Gross"), operation(snapshot, "B1", "43")],
			},
			Date.now() + 60_000,
		);
		expect(plan.touchedParts).toEqual(["xl/worksheets/sheet1.xml"]);
		expect(plan.semanticDiff).toHaveLength(2);

		const output = commitXlsx(source, snapshot, plan);
		const reopenedArchive = PackageArchive.open(output);
		const reopened = inspectXlsx(reopenedArchive, "xlsx-1", 2);
		expect(reopened.sheets[0]?.cells.find((cell) => cell.address === "A1")).toMatchObject({
			id: "rSheet1:A1",
			value: "Net & Gross",
			styleId: "2",
			editable: true,
		});
		expect(reopened.sheets[0]?.cells.find((cell) => cell.address === "B1")?.value).toBe("43");
		expect(new TextDecoder().decode(reopenedArchive.read("xl/worksheets/sheet1.xml"))).toContain("Net &amp; Gross");
		expect(reopenedArchive.read("docProps/custom.xml")).toEqual(source.read("docProps/custom.xml"));
		expect(reopenedArchive.read("xl/sharedStrings.xml")).toEqual(source.read("xl/sharedStrings.xml"));
	});

	it("roundtrips BOM worksheet anchors and nested Strict package targets", () => {
		for (const [name, bytes] of [
			["bom", fixture({ bomWorksheet: true })],
			["nested-strict", fixture({ nested: true, strictPackage: true })],
		] as const) {
			const archive = PackageArchive.open(bytes);
			const snapshot = inspectXlsx(archive, name);
			const plan = planXlsx(
				archive,
				snapshot,
				{ protocolVersion: 1, operations: [operation(snapshot, "A1", `${name} changed`)] },
				Date.now() + 60_000,
			);
			const reopened = inspectXlsx(PackageArchive.open(commitXlsx(archive, snapshot, plan)), name, 2);
			expect(reopened.sheets[0]?.cells.find((cell) => cell.address === "A1")?.value).toBe(`${name} changed`);
		}
	});

	it("blocks formula cells and rejects tampered plans", () => {
		const archive = PackageArchive.open(fixture());
		const snapshot = inspectXlsx(archive, "xlsx-2");
		expect(() =>
			planXlsx(
				archive,
				snapshot,
				{ protocolVersion: 1, operations: [operation(snapshot, "C1", "0")] },
				Date.now() + 60_000,
			),
		).toThrowError(OfficeEngineError);

		const plan = planXlsx(
			archive,
			snapshot,
			{ protocolVersion: 1, operations: [operation(snapshot, "A1", "Changed")] },
			Date.now() + 60_000,
		);
		expect(() =>
			commitXlsx(archive, snapshot, { ...plan, semanticDiff: [{ ...plan.semanticDiff[0]!, after: "tampered" }] }),
		).toThrowError(OfficeEngineError);
	});

	it("admits and roundtrips the fixed real Excel corpus", () => {
		const { root, manifest } = assertXlsxCorpusAdmission();
		expect(manifest.fixtures).toHaveLength(1);
		const admitted = manifest.fixtures[0];
		if (!admitted) throw new Error("XLSX corpus manifest is empty");
		expect(admitted.source.url).toBe(
			"https://raw.githubusercontent.com/apache/poi/87cdef57b0f714369c391e625180a59507a24576/test-data/spreadsheet/SimpleNormal.xlsx",
		);
		expect(admitted.legalFiles).toEqual(["APACHE-POI-LICENSE.txt", "APACHE-POI-NOTICE.txt"]);
		const bytes = new Uint8Array(readFileSync(resolve(root, admitted.filename)));
		const snapshot = inspectXlsx(PackageArchive.open(bytes), "admitted-xlsx");
		const cell = snapshot.sheets
			.find((sheet) => sheet.id === admitted.expected.sheetId)
			?.cells.find((item) => item.id === admitted.expected.cellId);
		expect(cell).toMatchObject({
			address: admitted.expected.address,
			value: admitted.expected.value,
			editable: true,
		});
	});

	it("decodes standard entities in consumed workbook text", () => {
		let archive = PackageArchive.open(fixture());
		archive = replaceText(archive, "xl/workbook.xml", 'name="Budget"', 'name="R&amp;D &#38; Ops"');
		archive = replaceText(archive, "xl/sharedStrings.xml", "Revenue", "R&amp;D &#x26; Sales");
		const snapshot = inspectXlsx(archive, "entities");
		expect(snapshot.sheets[0]?.name).toBe("R&D & Ops");
		expect(snapshot.sheets[0]?.cells.find((cell) => cell.address === "A1")?.value).toBe("R&D & Sales");
	});

	it("marks unmodeled and foreign cell attributes read-only and rejects foreign addresses", () => {
		const archive = PackageArchive.open(fixture());
		for (const attribute of ['cm="1"', 'vm="2"', 'ph="1"', 'xmlns:evil="urn:evil" evil:t="s"']) {
			const changed = replaceText(archive, "xl/worksheets/sheet1.xml", '<c r="B1">', `<c r="B1" ${attribute}>`);
			expect(
				inspectXlsx(changed, `attribute-${attribute}`).sheets[0]?.cells.find((cell) => cell.address === "B1"),
			).toMatchObject({ editable: false, blockedReason: "unsupported-cell" });
		}
		const foreignAddress = replaceText(
			archive,
			"xl/worksheets/sheet1.xml",
			'<c r="B1">',
			'<c xmlns:evil="urn:evil" evil:r="B1">',
		);
		expect(() => inspectXlsx(foreignAddress, "foreign-address")).toThrowError(OfficeEngineError);
	});

	it("rejects cells outside worksheet rows and row/address mismatches", () => {
		const archive = PackageArchive.open(fixture());
		const outsideRow = replaceText(
			archive,
			"xl/worksheets/sheet1.xml",
			"</sheetData>",
			'<c r="A2"><v>1</v></c></sheetData>',
		);
		expect(() => inspectXlsx(outsideRow, "outside-row")).toThrowError(OfficeEngineError);
		const mismatchedRow = replaceText(archive, "xl/worksheets/sheet1.xml", '<row r="1">', '<row r="2">');
		expect(() => inspectXlsx(mismatchedRow, "mismatched-row")).toThrowError(OfficeEngineError);
	});

	it("requires exact consumed part content types and unique declarations", () => {
		const archive = PackageArchive.open(fixture());
		for (const [search, replacement] of [
			["application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml", "application/xml"],
			["application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml", "application/xml"],
		] as const) {
			expect(() =>
				inspectXlsx(replaceText(archive, "[Content_Types].xml", search, replacement), search),
			).toThrowError(OfficeEngineError);
		}
		const duplicate = replaceText(
			archive,
			"[Content_Types].xml",
			"</Types>",
			'<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
		);
		expect(() => inspectXlsx(duplicate, "duplicate-content-type")).toThrowError(OfficeEngineError);
	});

	it("rejects DTD relationship XML and invalid XML replacement characters", () => {
		const original = PackageArchive.open(fixture());
		const malicious = original.replace(
			"_rels/.rels",
			encode(
				'<!DOCTYPE Relationships><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="root" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
			),
		);
		expect(() => inspectXlsx(PackageArchive.open(malicious), "malicious")).toThrowError(OfficeEngineError);
		const snapshot = inspectXlsx(original, "invalid-char");
		expect(() =>
			planXlsx(
				original,
				snapshot,
				{ protocolVersion: 1, operations: [operation(snapshot, "A1", "bad\u0000value")] },
				Date.now() + 60_000,
			),
		).toThrowError(OfficeEngineError);
	});

	it("rejects stale, expired, duplicate, and empty transactions", () => {
		const archive = PackageArchive.open(fixture());
		const snapshot = inspectXlsx(archive, "xlsx-boundaries");
		const valid = operation(snapshot, "A1", " Changed ");
		expect(() =>
			planXlsx(archive, snapshot, { protocolVersion: 1, operations: [] }, Date.now() + 60_000),
		).toThrowError(OfficeEngineError);
		expect(() =>
			planXlsx(archive, snapshot, { protocolVersion: 1, operations: [valid] }, Date.now() - 1),
		).toThrowError(OfficeEngineError);
		expect(() =>
			planXlsx(archive, snapshot, { protocolVersion: 1, operations: [valid, valid] }, Date.now() + 60_000),
		).toThrowError(OfficeEngineError);
		expect(() =>
			planXlsx(
				archive,
				snapshot,
				{
					protocolVersion: 1,
					operations: [{ ...valid, precondition: { ...valid.precondition, documentRevision: 99 } }],
				},
				Date.now() + 60_000,
			),
		).toThrowError(OfficeEngineError);
		const changedArchive = PackageArchive.open(archive.replace("docProps/custom.xml", encode("changed")));
		expect(() =>
			planXlsx(changedArchive, snapshot, { protocolVersion: 1, operations: [valid] }, Date.now() + 60_000),
		).toThrowError(OfficeEngineError);

		const plan = planXlsx(archive, snapshot, { protocolVersion: 1, operations: [valid] }, Date.now() + 60_000);
		expect(() => commitXlsx(archive, snapshot, plan, plan.expiresAt)).toThrowError(OfficeEngineError);
		const output = commitXlsx(archive, snapshot, plan);
		expect(new TextDecoder().decode(PackageArchive.open(output).read("xl/worksheets/sheet1.xml"))).toContain(
			'xml:space="preserve"',
		);
	});

	it("rejects worksheet namespace, consumed metadata namespaces, duplicate cells, and XML depth violations", () => {
		const archive = PackageArchive.open(fixture());
		const wrongNamespace = archive.replace(
			"xl/worksheets/sheet1.xml",
			encode('<worksheet xmlns="urn:not-spreadsheet"><sheetData/></worksheet>'),
		);
		expect(() => inspectXlsx(PackageArchive.open(wrongNamespace), "wrong-namespace")).toThrowError(OfficeEngineError);

		const namespaceCases = [
			["_rels/.rels", "http://schemas.openxmlformats.org/package/2006/relationships"],
			["[Content_Types].xml", "http://schemas.openxmlformats.org/package/2006/content-types"],
			["xl/workbook.xml", "http://schemas.openxmlformats.org/spreadsheetml/2006/main"],
			["xl/sharedStrings.xml", "http://schemas.openxmlformats.org/spreadsheetml/2006/main"],
		] as const;
		for (const [part, namespace] of namespaceCases) {
			const invalid = replaceText(archive, part, namespace, "urn:not-office");
			expect(() => inspectXlsx(invalid, `wrong-namespace-${part}`)).toThrowError(OfficeEngineError);
		}

		const duplicateCell = replaceText(
			archive,
			"xl/worksheets/sheet1.xml",
			'<c r="B1"><v>42</v></c>',
			'<c r="B1"><v>42</v></c><c r="B1"><v>43</v></c>',
		);
		expect(() => inspectXlsx(duplicateCell, "duplicate-cell")).toThrowError(OfficeEngineError);

		const foreignCellContent = replaceText(
			archive,
			"xl/worksheets/sheet1.xml",
			'<c r="B1"><v>42</v></c>',
			'<c r="B1" xmlns:evil="urn:evil"><v>42</v><evil:metadata>keep</evil:metadata></c>',
		);
		expect(
			inspectXlsx(foreignCellContent, "foreign-cell").sheets[0]?.cells.find((cell) => cell.address === "B1"),
		).toMatchObject({ editable: false, blockedReason: "unsupported-cell" });

		const deepWorkbook = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${"<x>".repeat(257)}${"</x>".repeat(257)}</workbook>`;
		const tooDeep = archive.replace("xl/workbook.xml", encode(deepWorkbook));
		expect(() => inspectXlsx(PackageArchive.open(tooDeep), "too-deep")).toThrowError(OfficeEngineError);
	});

	it("rejects ambiguous, macro-enabled, duplicate, and external package relationships", () => {
		const archive = PackageArchive.open(fixture());
		const noOfficeRelationship = archive.replace(
			"_rels/.rels",
			encode('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'),
		);
		expect(() => inspectXlsx(PackageArchive.open(noOfficeRelationship), "missing-office")).toThrowError(
			OfficeEngineError,
		);

		const macro = replaceText(
			archive,
			"[Content_Types].xml",
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
			"application/vnd.ms-excel.sheet.macroEnabled.main+xml",
		);
		expect(() => inspectXlsx(macro, "macro")).toThrowError(OfficeEngineError);

		const worksheetRelationship =
			'<Relationship Id="rSheet1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>';
		const duplicate = replaceText(
			archive,
			"xl/_rels/workbook.xml.rels",
			worksheetRelationship,
			worksheetRelationship.repeat(2),
		);
		expect(() => inspectXlsx(duplicate, "duplicate-relationship")).toThrowError(OfficeEngineError);

		const escapedTarget = replaceText(
			archive,
			"xl/_rels/workbook.xml.rels",
			"worksheets/sheet1.xml",
			"../../../outside.xml",
		);
		expect(() => inspectXlsx(escapedTarget, "escaped-target")).toThrowError(OfficeEngineError);

		const externalUnrelated = replaceText(
			archive,
			"xl/_rels/workbook.xml.rels",
			"</Relationships>",
			'<Relationship Id="external" Type="urn:external" Target="https://example.com/data" TargetMode="External"/></Relationships>',
		);
		expect(() => inspectXlsx(externalUnrelated, "external-unrelated")).toThrowError(OfficeEngineError);

		const sharedRelationship =
			'<Relationship Id="rStrings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>';
		const twoShared = replaceText(
			archive,
			"xl/_rels/workbook.xml.rels",
			sharedRelationship,
			`${sharedRelationship}<Relationship Id="rStrings2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`,
		);
		expect(() => inspectXlsx(twoShared, "two-shared")).toThrowError(OfficeEngineError);

		const externalShared = replaceText(
			archive,
			"xl/_rels/workbook.xml.rels",
			sharedRelationship,
			sharedRelationship.replace("/>", ' TargetMode="External"/>'),
		);
		expect(() => inspectXlsx(externalShared, "external-shared")).toThrowError(OfficeEngineError);
	});

	it("rejects cross-worksheet transactions and unsupported structure or sharedStrings operations", () => {
		const archive = PackageArchive.open(fixture({ secondWorksheet: true }));
		const snapshot = inspectXlsx(archive, "xlsx-boundaries");
		expect(snapshot.sheets).toHaveLength(2);
		expect(() =>
			planXlsx(
				archive,
				snapshot,
				{
					protocolVersion: 1,
					operations: [operation(snapshot, "A1", "Changed"), operation(snapshot, "A1", "8", 1)],
				},
				Date.now() + 60_000,
			),
		).toThrowError(OfficeEngineError);

		for (const type of ["create_cell", "add_worksheet", "set_shared_string"]) {
			const envelope = {
				protocolVersion: 1,
				operations: [{ type }],
			} as unknown as Parameters<typeof planXlsx>[2];
			expect(() => planXlsx(archive, snapshot, envelope, Date.now() + 60_000)).toThrowError(OfficeEngineError);
		}
	});

	it("requires exact keys, hashes, existing addresses, and a single worksheet", () => {
		const archive = PackageArchive.open(fixture());
		const snapshot = inspectXlsx(archive, "xlsx-3");
		const valid = operation(snapshot, "A1", "Changed");
		expect(() =>
			planXlsx(
				archive,
				snapshot,
				{ protocolVersion: 1, operations: [{ ...valid, extra: true }] },
				Date.now() + 60_000,
			),
		).toThrowError(OfficeEngineError);
		expect(() =>
			planXlsx(
				archive,
				snapshot,
				{
					protocolVersion: 1,
					operations: [{ ...valid, precondition: { ...valid.precondition, expectedValueSha256: "0".repeat(64) } }],
				},
				Date.now() + 60_000,
			),
		).toThrowError(OfficeEngineError);
		expect(() =>
			planXlsx(
				archive,
				snapshot,
				{ protocolVersion: 1, operations: [{ ...valid, target: { ...valid.target, address: "A2" } }] },
				Date.now() + 60_000,
			),
		).toThrowError(OfficeEngineError);
	});
});
