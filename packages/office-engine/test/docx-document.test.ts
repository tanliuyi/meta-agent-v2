import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
	TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP,
	TRANSITIONAL_PACKAGE_RELATIONSHIPS_NAMESPACE,
	WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE,
} from "../src/docx.ts";
import { inspectDocxModel } from "../src/docx-document.ts";
import { inspectDocx, OfficeEngineError, PackageArchive } from "../src/index.ts";

const encoder = new TextEncoder();
const WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function archiveBytes(documentBytes: Uint8Array): PackageArchive {
	const contentTypes = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="${WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE}"/></Types>`;
	const relationships = `<Relationships xmlns="${TRANSITIONAL_PACKAGE_RELATIONSHIPS_NAMESPACE}"><Relationship Id="rId1" Type="${TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP}" Target="word/document.xml"/></Relationships>`;
	return PackageArchive.open(
		zipSync({
			"[Content_Types].xml": encoder.encode(contentTypes),
			"_rels/.rels": encoder.encode(relationships),
			"word/document.xml": documentBytes,
		}),
	);
}

function archive(documentXml: string): PackageArchive {
	return archiveBytes(encoder.encode(documentXml));
}

function expectCode(action: () => unknown, code: string): void {
	expect(action).toThrowError(OfficeEngineError);
	try {
		action();
	} catch (error: unknown) {
		if (error instanceof OfficeEngineError) expect(error.code).toBe(code);
	}
}

describe("DOCX document inspect", () => {
	it("inspects ordinary paragraphs, runs, properties, and stable IDs", () => {
		const xml = `<w:document xmlns:w="${WORD_NAMESPACE}"><w:body><w:p><w:r><w:rPr><w:b/><w:i w:val="false"/><w:rStyle w:val="Heading1"/></w:rPr><w:t>Hello</w:t></w:r><w:r><w:t> world</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body></w:document>`;
		const first = inspectDocx(archive(xml));
		const second = inspectDocx(archive(xml));
		expect(first).toEqual(second);
		expect(first.mainPartPath).toBe("word/document.xml");
		expect(first.paragraphs[0]).toMatchObject({
			id: "p-0",
			runs: [
				{
					id: "r-0-0",
					text: "Hello",
					properties: { bold: true, italic: false, styleId: "Heading1" },
					editable: true,
				},
				{ id: "r-0-1", text: " world", properties: {}, editable: true },
			],
		});
		expect(first.paragraphs[1].runs[0]).toMatchObject({ id: "r-1-0", text: "Second", editable: true });
	});

	it("recognizes alternate namespace prefixes and XML text references", () => {
		const xml = `<?xml version="1.0"?><x:document xmlns:x="${WORD_NAMESPACE}"><x:body><x:p><x:r><x:t xml:space="preserve">A&amp;B &lt;ok&gt; &#x1F600; &#x4E2D;&#x6587; e&#x301; </x:t></x:r></x:p></x:body></x:document>`;
		const snapshot = inspectDocx(archive(xml));
		expect(snapshot.paragraphs[0].runs[0].text).toBe("A&B <ok> 😀 中文 é ");
	});

	it("allows an empty ordinary text node and records exact UTF-8 anchors", () => {
		const xml = `<w:document xmlns:w="${WORD_NAMESPACE}"><w:body><w:p><w:r><w:t></w:t></w:r><w:r><w:t>前😀é</w:t></w:r></w:p></w:body></w:document>`;
		const model = inspectDocxModel(archive(xml));
		const runs = model.snapshot.paragraphs[0].runs;
		expect(runs[0]).toMatchObject({ text: "", editable: true });
		const emptyAnchor = model.rawAnchors.get(runs[0].id);
		const textAnchor = model.rawAnchors.get(runs[1].id);
		if (
			emptyAnchor === undefined ||
			textAnchor === undefined ||
			emptyAnchor.text === undefined ||
			textAnchor.text === undefined
		)
			throw new Error("missing raw anchor");
		const source = model.source;
		expect(new TextDecoder().decode(source.subarray(emptyAnchor.run.start, emptyAnchor.run.end))).toBe(
			"<w:r><w:t></w:t></w:r>",
		);
		expect(new TextDecoder().decode(source.subarray(textAnchor.text.start, textAnchor.text.end))).toBe("前😀é");
		expect("rawAnchors" in inspectDocx(archive(xml))).toBe(false);
	});

	it("preserves a UTF-8 BOM in raw anchor offsets", () => {
		const xml = `<w:document xmlns:w="${WORD_NAMESPACE}"><w:body><w:p><w:r><w:t>前😀</w:t></w:r></w:p></w:body></w:document>`;
		const encoded = encoder.encode(xml);
		const bytes = new Uint8Array(3 + encoded.length);
		bytes.set([0xef, 0xbb, 0xbf]);
		bytes.set(encoded, 3);
		const model = inspectDocxModel(archiveBytes(bytes));
		const run = model.snapshot.paragraphs[0].runs[0];
		const anchor = model.rawAnchors.get(run.id);
		if (anchor === undefined || anchor.text === undefined) throw new Error("missing BOM raw anchor");
		expect(new TextDecoder().decode(model.source.subarray(anchor.run.start, anchor.run.end))).toBe(
			"<w:r><w:t>前😀</w:t></w:r>",
		);
		expect(new TextDecoder().decode(model.source.subarray(anchor.text.start, anchor.text.end))).toBe("前😀");
		expect(anchor.run.start).toBe(3 + encoder.encode(xml.slice(0, xml.indexOf("<w:r>"))).length);
	});

	it("blocks self-closing text but anchors ordinary empty text", () => {
		const xml = `<w:document xmlns:w="${WORD_NAMESPACE}"><w:body><w:p><w:r><w:t/></w:r><w:r><w:t></w:t></w:r></w:p></w:body></w:document>`;
		const model = inspectDocxModel(archive(xml));
		const runs = model.snapshot.paragraphs[0].runs;
		expect(runs[0]).toMatchObject({ text: "", editable: false, blockedReason: "unsafe_structure" });
		expect(runs[1]).toMatchObject({ text: "", editable: true });
		const selfClosingAnchor = model.rawAnchors.get(runs[0].id);
		const ordinaryAnchor = model.rawAnchors.get(runs[1].id);
		if (selfClosingAnchor === undefined || ordinaryAnchor === undefined) throw new Error("missing text anchors");
		expect(selfClosingAnchor.text).toBeUndefined();
		if (ordinaryAnchor.text === undefined) throw new Error("missing ordinary empty text anchor");
		expect(ordinaryAnchor.text.start).toBe(ordinaryAnchor.text.end);
		expect(new TextDecoder().decode(model.source.subarray(ordinaryAnchor.run.start, ordinaryAnchor.run.end))).toBe(
			"<w:r><w:t></w:t></w:r>",
		);
	});

	it("blocks multi-text and non-text runs", () => {
		const xml = `<w:document xmlns:w="${WORD_NAMESPACE}"><w:body><w:p><w:r><w:t>a</w:t><w:t>b</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>ok</w:t><w:br/></w:r></w:p></w:body></w:document>`;
		const runs = inspectDocx(archive(xml)).paragraphs[0].runs;
		expect(runs.map((run) => [run.text, run.editable, run.blockedReason])).toEqual([
			["ab", false, "multiple_text_nodes"],
			["", false, "non_text_child"],
			["ok", false, "non_text_child"],
		]);
	});

	it("marks unsupported structures and conservatively blocks affected runs", () => {
		const xml = `<w:document xmlns:w="${WORD_NAMESPACE}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>
			<w:p><w:ins><w:r><w:t>tracked</w:t></w:r></w:ins><w:r><w:t>also blocked</w:t></w:r></w:p>
			<w:p><w:fldSimple><w:r><w:t>field</w:t></w:r></w:fldSimple><w:r><w:t>after field</w:t></w:r></w:p>
			<w:p><w:sdt><w:sdtContent><w:r><w:t>control</w:t></w:r></w:sdtContent></w:sdt></w:p>
			<w:p><w:hyperlink r:id="rId2"><w:r><w:t>link</w:t></w:r></w:hyperlink></w:p>
			<w:p><w:r><w:drawing><w:t>draw</w:t></w:drawing></w:r></w:p>
			<w:tbl/><w:sectPr/>
		</w:body></w:document>`;
		const snapshot = inspectDocx(archive(xml));
		expect(snapshot.presence).toEqual({
			section: true,
			table: true,
			drawing: true,
			field: true,
			revision: true,
			content_control: true,
			hyperlink: true,
			unknown: false,
			unsafe: false,
		});
		expect(snapshot.paragraphs[0].runs[0]).toMatchObject({ editable: false, blockedReason: "tracked_revision" });
		expect(snapshot.paragraphs[0].runs[1]).toMatchObject({ editable: true });
		expect(snapshot.paragraphs[1].runs[0]).toMatchObject({ editable: false, blockedReason: "field" });
		expect(snapshot.paragraphs[1].runs[1]).toMatchObject({ editable: true });
		expect(snapshot.paragraphs[2].runs[0]).toMatchObject({ editable: false, blockedReason: "content_control" });
		expect(snapshot.paragraphs[3].runs[0]).toMatchObject({ editable: false, blockedReason: "hyperlink" });
		expect(snapshot.paragraphs[4].runs[0]).toMatchObject({ editable: false, blockedReason: "drawing" });
	});

	it("keeps ordinary siblings editable around local unsupported wrappers", () => {
		const xml = `<w:document xmlns:w="${WORD_NAMESPACE}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>
			<w:p><w:ins><w:r><w:t>tracked</w:t></w:r></w:ins><w:r><w:t>safe after revision</w:t></w:r></w:p>
			<w:p><w:fldSimple><w:r><w:t>field</w:t></w:r></w:fldSimple><w:r><w:t>safe after field</w:t></w:r></w:p>
			<w:p><w:sdt><w:sdtContent><w:r><w:t>control</w:t></w:r></w:sdtContent></w:sdt><w:r><w:t>safe after control</w:t></w:r></w:p>
			<w:p><w:hyperlink r:id="rId2"><w:r><w:t>link</w:t></w:r></w:hyperlink><w:r><w:t>safe after link</w:t></w:r></w:p>
			<w:p><w:r><w:drawing><w:t>draw</w:t></w:drawing></w:r><w:r><w:t>safe after drawing</w:t></w:r></w:p>
		</w:body></w:document>`;
		const model = inspectDocxModel(archive(xml));
		for (const paragraph of model.snapshot.paragraphs) {
			expect(paragraph.runs[0]).toMatchObject({ editable: false });
			expect(paragraph.runs[1]).toMatchObject({ editable: true });
			const blockedAnchor = model.rawAnchors.get(paragraph.runs[0].id);
			const safeAnchor = model.rawAnchors.get(paragraph.runs[1].id);
			if (blockedAnchor === undefined || safeAnchor === undefined) throw new Error("missing wrapper sibling anchor");
			expect(blockedAnchor.text).toBeUndefined();
			expect(safeAnchor.text).toBeDefined();
		}
	});

	it("blocks the whole paragraph for complex field boundaries", () => {
		const xml = `<w:document xmlns:w="${WORD_NAMESPACE}"><w:body><w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:t>result</w:t></w:r></w:p></w:body></w:document>`;
		const model = inspectDocxModel(archive(xml));
		for (const run of model.snapshot.paragraphs[0].runs) {
			expect(run).toMatchObject({ editable: false, blockedReason: "field" });
			const anchor = model.rawAnchors.get(run.id);
			if (anchor === undefined) throw new Error("missing complex field anchor");
			expect(anchor.text).toBeUndefined();
		}
	});

	it("enforces the scanner element nesting limit", () => {
		const nested = (depth: number): string => `${"<w:pPr>".repeat(depth)}${"</w:pPr>".repeat(depth)}`;
		const documentXml = (depth: number): string =>
			`<w:document xmlns:w="${WORD_NAMESPACE}"><w:body><w:p>${nested(depth)}</w:p></w:body></w:document>`;
		expectCode(() => inspectDocx(archive(documentXml(98))), "XML_INVALID");
		expect(inspectDocx(archive(documentXml(97))).format).toBe("docx");
	});

	it("keeps unknown markup opaque and does not expose internal anchors", () => {
		const xml = `<w:document xmlns:w="${WORD_NAMESPACE}" xmlns:z="urn:unknown"><w:body><w:p><z:opaque/><w:r><w:t>safe-looking</w:t></w:r></w:p></w:body></w:document>`;
		const snapshot = inspectDocx(archive(xml));
		expect(snapshot.presence.unknown).toBe(true);
		expect(snapshot.paragraphs[0].presence.unknown).toBe(true);
		expect(snapshot.paragraphs[0].runs[0]).toMatchObject({ editable: false, blockedReason: "unknown_markup" });
		expect("rawAnchors" in snapshot).toBe(false);
	});

	it("rejects unsafe token and ancestry shapes without text anchors", () => {
		const xml = `<w:document xmlns:w="${WORD_NAMESPACE}" xmlns:z="urn:unknown"><w:body><!--opaque--><w:p><w:pPr><w:r><w:t>ppr</w:t></w:r></w:pPr><w:r data="a > b"><w:t>a<z:nested/>b</w:t></w:r><w:r><w:t><![CDATA[cdata]]></w:t></w:r><w:r><w:t>comment</w:t><!-- comment --></w:r><w:r>direct text<w:r><w:t>nested</w:t></w:r></w:r></w:p><z:unknown/></w:body></w:document>`;
		const model = inspectDocxModel(archive(xml));
		const runs = model.snapshot.paragraphs[0].runs;
		expect(runs.map((run) => [run.text, run.editable, run.blockedReason])).toEqual([
			["ppr", false, "unsafe_structure"],
			["ab", false, "unsafe_structure"],
			["", false, "unsafe_structure"],
			["comment", false, "unsafe_structure"],
			["", false, "unsafe_structure"],
			["nested", false, "unsafe_structure"],
		]);
		for (const run of runs) {
			const anchor = model.rawAnchors.get(run.id);
			if (anchor === undefined) throw new Error("missing run anchor");
			expect(anchor.text).toBeUndefined();
		}
		expect(model.snapshot.presence.unsafe).toBe(true);
		expect(model.snapshot.presence.unknown).toBe(true);
	});

	it("requires one body and reports opaque root/body content", () => {
		const opaque = inspectDocx(
			archive(
				`<!--before--><w:document xmlns:w="${WORD_NAMESPACE}">text<w:body><w:p><w:r><w:t>ok</w:t></w:r></w:p><![CDATA[tail]]></w:body><z:other xmlns:z="urn:z"/></w:document>`,
			),
		);
		expect(opaque.presence.unknown).toBe(true);
		expect(opaque.presence.unsafe).toBe(true);
		expectCode(
			() => inspectDocx(archive(`<w:document xmlns:w="${WORD_NAMESPACE}"><w:body/><w:body/></w:document>`)),
			"DOCX_DOCUMENT_INVALID",
		);
	});

	it("blocks ordinary runs with direct opaque or text content independently", () => {
		const cases = [
			`<w:p><w:r><w:t>run comment</w:t><!--comment--></w:r></w:p>`,
			`<w:p><w:r><w:rPr><!--comment--><w:b/></w:rPr><w:t>rPr comment</w:t></w:r></w:p>`,
			`<w:p><w:ins>wrapper text<w:r><w:t>wrapper</w:t></w:r></w:ins></w:p>`,
			`<w:p><w:pPr>pPr text<w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>pPr</w:t></w:r></w:p>`,
		];
		for (const paragraph of cases) {
			const snapshot = inspectDocx(
				archive(`<w:document xmlns:w="${WORD_NAMESPACE}"><w:body>${paragraph}</w:body></w:document>`),
			);
			const run = snapshot.paragraphs[0].runs[0];
			expect(run).toMatchObject({ editable: false, blockedReason: "unsafe_structure" });
			expect("rawAnchors" in snapshot).toBe(false);
		}
	});

	it("keeps ordinary paragraph properties out of run structure", () => {
		const xml = `<w:document xmlns:w="${WORD_NAMESPACE}"><w:body><w:p><w:pPr><w:pStyle w:val="Normal"/><w:spacing w:before="120"/><w:jc w:val="center"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>ok</w:t></w:r></w:p></w:body></w:document>`;
		const model = inspectDocxModel(archive(xml));
		const run = model.snapshot.paragraphs[0].runs[0];
		expect(run.editable).toBe(true);
		const anchor = model.rawAnchors.get(run.id);
		if (anchor === undefined) throw new Error("missing run anchor");
		expect(anchor.text).toBeDefined();
	});

	it("blocks malformed ordinary run ordering", () => {
		const xml = `<w:document xmlns:w="${WORD_NAMESPACE}"><w:body><w:p><w:r><w:t>before</w:t><w:rPr><w:b/></w:rPr></w:r><w:r><w:rPr/><w:rPr/><w:t>duplicate</w:t></w:r></w:p></w:body></w:document>`;
		const runs = inspectDocx(archive(xml)).paragraphs[0].runs;
		expect(runs).toEqual([
			expect.objectContaining({ text: "before", editable: false, blockedReason: "unsafe_structure" }),
			expect.objectContaining({ text: "duplicate", editable: false, blockedReason: "unsafe_structure" }),
		]);
	});

	it("rejects invalid entities in the main document", () => {
		const xml = `<w:document xmlns:w="${WORD_NAMESPACE}"><w:body><w:p><w:r><w:t>&evil;</w:t></w:r></w:p></w:body></w:document>`;
		expectCode(() => inspectDocx(archive(xml)), "XML_ENTITY_FORBIDDEN");
	});
});
