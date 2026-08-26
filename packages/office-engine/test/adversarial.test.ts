import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
	CONTENT_TYPES_NAMESPACE,
	OfficeEngineError,
	PackageArchive,
	resolveDocx,
	STRICT_OFFICE_DOCUMENT_RELATIONSHIP,
	TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP,
	TRANSITIONAL_PACKAGE_RELATIONSHIPS_NAMESPACE,
	WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE,
} from "../src/index.ts";

const encoder = new TextEncoder();
const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;

function text(value: string): Uint8Array {
	return encoder.encode(value);
}

function read16(data: Uint8Array, offset: number): number {
	return data[offset] | (data[offset + 1] << 8);
}

function read32(data: Uint8Array, offset: number): number {
	return (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
}

function write16(data: Uint8Array, offset: number, value: number): void {
	data[offset] = value & 0xff;
	data[offset + 1] = (value >>> 8) & 0xff;
}

function write32(data: Uint8Array, offset: number, value: number): void {
	data[offset] = value & 0xff;
	data[offset + 1] = (value >>> 8) & 0xff;
	data[offset + 2] = (value >>> 16) & 0xff;
	data[offset + 3] = (value >>> 24) & 0xff;
}

function eocd(data: Uint8Array): number {
	for (let offset = data.length - 22; offset >= 0; offset -= 1) {
		if (read32(data, offset) === EOCD && offset + 22 + read16(data, offset + 20) === data.length) return offset;
	}
	throw new Error("fixture EOCD not found");
}

interface RecordLocation {
	readonly central: number;
	readonly local: number;
	readonly data: number;
	readonly compressedSize: number;
}

function records(data: Uint8Array): RecordLocation[] {
	const end = eocd(data);
	const count = read16(data, end + 10);
	let cursor = read32(data, end + 16);
	const result: RecordLocation[] = [];
	for (let index = 0; index < count; index += 1) {
		if (read32(data, cursor) !== CENTRAL) throw new Error("fixture central record not found");
		const nameLength = read16(data, cursor + 28);
		const extraLength = read16(data, cursor + 30);
		const commentLength = read16(data, cursor + 32);
		const local = read32(data, cursor + 42);
		const localNameLength = read16(data, local + 26);
		const localExtraLength = read16(data, local + 28);
		result.push({
			central: cursor,
			local,
			data: local + 30 + localNameLength + localExtraLength,
			compressedSize: read32(data, cursor + 20),
		});
		cursor += 46 + nameLength + extraLength + commentLength;
	}
	return result;
}

function zip(files: ReadonlyArray<readonly [string, Uint8Array]>): Uint8Array {
	const input: Record<string, Uint8Array> = {};
	for (const [name, content] of files) input[name] = content;
	return zipSync(input);
}

function deflatedZip(path: string, content: Uint8Array): Uint8Array {
	return zipSync({ [path]: [content, { level: 9 }] });
}

function storedZip(files: ReadonlyArray<readonly [string, Uint8Array]>): Uint8Array {
	const localSize = files.reduce(
		(total, [name, content]) => total + 30 + encoder.encode(name).length + content.length,
		0,
	);
	const centralSize = files.reduce((total, [name]) => total + 46 + encoder.encode(name).length, 0);
	const result = new Uint8Array(localSize + centralSize + 22);
	const offsets: number[] = [];
	let cursor = 0;
	for (const [name, content] of files) {
		const nameBytes = encoder.encode(name);
		offsets.push(cursor);
		write32(result, cursor, 0x04034b50);
		write16(result, cursor + 4, 20);
		write16(result, cursor + 8, 0);
		write32(result, cursor + 14, crc32(content));
		write32(result, cursor + 18, content.length);
		write32(result, cursor + 22, content.length);
		write16(result, cursor + 26, nameBytes.length);
		result.set(nameBytes, cursor + 30);
		result.set(content, cursor + 30 + nameBytes.length);
		cursor += 30 + nameBytes.length + content.length;
	}
	const centralOffset = cursor;
	for (let index = 0; index < files.length; index += 1) {
		const [name, content] = files[index];
		const nameBytes = encoder.encode(name);
		const central = cursor;
		write32(result, central, CENTRAL);
		write16(result, central + 4, 20);
		write16(result, central + 6, 20);
		write16(result, central + 8, 0);
		write16(result, central + 10, 0);
		write32(result, central + 16, crc32(content));
		write32(result, central + 20, content.length);
		write32(result, central + 24, content.length);
		write16(result, central + 28, nameBytes.length);
		write16(result, central + 34, 0);
		write32(result, central + 42, offsets[index]);
		result.set(nameBytes, central + 46);
		cursor += 46 + nameBytes.length;
	}
	write32(result, cursor, EOCD);
	write16(result, cursor + 8, files.length);
	write16(result, cursor + 10, files.length);
	write32(result, cursor + 12, centralSize);
	write32(result, cursor + 16, centralOffset);
	return result;
}

function escapedAttribute(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll("'", "&apos;");
}

interface DocxOptions {
	readonly target?: string;
	readonly relationshipTarget?: string;
	readonly relationshipType?: string;
	readonly targetMode?: string;
	readonly packageNamespace?: string;
	readonly contentTypesXml?: string;
	readonly relationshipsXml?: string;
	readonly includeMain?: boolean;
}

function docx(options: DocxOptions = {}): Uint8Array {
	const target = options.target ?? "word/document.xml";
	const relationshipTarget = options.relationshipTarget ?? target;
	const contentTypesXml =
		options.contentTypesXml ??
		`<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/${escapedAttribute(target)}" ContentType="${WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE}"/></Types>`;
	const relationshipNamespace = options.packageNamespace ?? TRANSITIONAL_PACKAGE_RELATIONSHIPS_NAMESPACE;
	const relationshipsXml =
		options.relationshipsXml ??
		`<Relationships xmlns="${relationshipNamespace}"><Relationship Id="rId1" Type="${options.relationshipType ?? TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP}" Target="${escapedAttribute(relationshipTarget)}"${options.targetMode === undefined ? "" : ` TargetMode="${escapedAttribute(options.targetMode)}"`}/></Relationships>`;
	const files: Array<readonly [string, Uint8Array]> = [
		["[Content_Types].xml", text(contentTypesXml)],
		["_rels/.rels", text(relationshipsXml)],
	];
	if (options.includeMain !== false) {
		files.push([
			target,
			text(
				'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
			),
		]);
	}
	return zip(files);
}

function withCentralZip64Extra(data: Uint8Array): Uint8Array {
	const location = records(data)[0];
	const end = eocd(data);
	const insertion = location.central + 46 + read16(data, location.central + 28);
	const result = new Uint8Array(data.length + 4);
	result.set(data.subarray(0, insertion));
	result.set(new Uint8Array([1, 0, 0, 0]), insertion);
	result.set(data.subarray(insertion), insertion + 4);
	write16(result, location.central + 30, 4);
	write32(result, end + 12 + 4, read32(data, end + 12) + 4);
	return result;
}

function withCentralExtra(data: Uint8Array, fieldId: number): Uint8Array {
	const location = records(data)[0];
	const end = eocd(data);
	const insertion = location.central + 46 + read16(data, location.central + 28) + read16(data, location.central + 30);
	const result = new Uint8Array(data.length + 4);
	result.set(data.subarray(0, insertion));
	write16(result, insertion, fieldId);
	write16(result, insertion + 2, 0);
	result.set(data.subarray(insertion), insertion + 4);
	write16(result, location.central + 30, read16(data, location.central + 30) + 4);
	write32(result, end + 12 + 4, read32(data, end + 12) + 4);
	return result;
}

function withLocalExtra(data: Uint8Array, fieldId: number): Uint8Array {
	const location = records(data)[0];
	const end = eocd(data);
	const insertion = location.local + 30 + read16(data, location.local + 26) + read16(data, location.local + 28);
	const result = new Uint8Array(data.length + 4);
	result.set(data.subarray(0, insertion));
	write16(result, insertion, fieldId);
	write16(result, insertion + 2, 0);
	result.set(data.subarray(insertion), insertion + 4);
	write16(result, location.local + 28, read16(data, location.local + 28) + 4);
	write32(result, end + 4 + 16, read32(data, end + 16) + 4);
	return result;
}

function copy(data: Uint8Array): Uint8Array {
	return new Uint8Array(data);
}

function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function expectCode(action: () => unknown, code: string): void {
	try {
		action();
	} catch (error: unknown) {
		expect(error).toBeInstanceOf(OfficeEngineError);
		if (error instanceof OfficeEngineError) expect(error.code).toBe(code);
		return;
	}
	throw new Error(`expected OfficeEngineError(${code})`);
}

describe("adversarial DOCX manifests", () => {
	it("accepts XML declarations and literal forbidden text in comments/CDATA", () => {
		const declaration = '<?xml version="1.0" encoding="UTF-8"?>';
		const contentTypesXml = `${declaration}<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><!-- &unknown; <!DOCTYPE Types> --><Override PartName="/word/document.xml" ContentType="${WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE}"/><Description><![CDATA[&unknown; <!DOCTYPE Types>]]></Description></Types>`;
		const relationshipsXml = `${declaration}<Relationships xmlns="${TRANSITIONAL_PACKAGE_RELATIONSHIPS_NAMESPACE}"><Relationship Id="rId1" Type="${TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP}" Target="word/document.xml"/></Relationships>`;
		expect(resolveDocx(PackageArchive.open(docx({ contentTypesXml, relationshipsXml }))).mainPart.path).toBe(
			"word/document.xml",
		);

		const processingInstruction = `<?not-xml value?><Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/word/document.xml" ContentType="${WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE}"/></Types>`;
		expectCode(
			() => resolveDocx(PackageArchive.open(docx({ contentTypesXml: processingInstruction }))),
			"XML_PI_FORBIDDEN",
		);
		const uppercaseEntity = `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/word/document.xml" ContentType="&AMP;"/></Types>`;
		expectCode(
			() => resolveDocx(PackageArchive.open(docx({ contentTypesXml: uppercaseEntity }))),
			"XML_ENTITY_FORBIDDEN",
		);
	});

	it("resolves rooted relationship targets and rejects authority targets", () => {
		expect(resolveDocx(PackageArchive.open(docx({ relationshipTarget: "/word/document.xml" }))).mainPart.path).toBe(
			"word/document.xml",
		);
		expectCode(
			() => resolveDocx(PackageArchive.open(docx({ relationshipTarget: "//host/word/document.xml" }))),
			"DOCX_TARGET_INVALID",
		);
	});

	it("requires relationship attributes, unique IDs, and valid Unicode NCNames", () => {
		for (const relationshipsXml of [
			`<Relationships xmlns="${TRANSITIONAL_PACKAGE_RELATIONSHIPS_NAMESPACE}"><Relationship Type="${TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP}" Target="word/document.xml"/></Relationships>`,
			`<Relationships xmlns="${TRANSITIONAL_PACKAGE_RELATIONSHIPS_NAMESPACE}"><Relationship Id="rId1" Target="word/document.xml"/></Relationships>`,
			`<Relationships xmlns="${TRANSITIONAL_PACKAGE_RELATIONSHIPS_NAMESPACE}"><Relationship Id="rId1" Type="${TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP}"/></Relationships>`,
		]) {
			expectCode(() => resolveDocx(PackageArchive.open(docx({ relationshipsXml }))), "DOCX_RELATIONSHIP_INVALID");
		}

		const duplicateId = `<Relationships xmlns="${TRANSITIONAL_PACKAGE_RELATIONSHIPS_NAMESPACE}"><Relationship Id="rId1" Type="${TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP}" Target="word/document.xml"/><Relationship Id="rId1" Type="urn:other" Target="other.xml"/></Relationships>`;
		expectCode(
			() => resolveDocx(PackageArchive.open(docx({ relationshipsXml: duplicateId }))),
			"DOCX_RELATIONSHIP_INVALID",
		);
		const invalidId = `<Relationships xmlns="${TRANSITIONAL_PACKAGE_RELATIONSHIPS_NAMESPACE}"><Relationship Id="1bad" Type="${TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP}" Target="word/document.xml"/></Relationships>`;
		expectCode(
			() => resolveDocx(PackageArchive.open(docx({ relationshipsXml: invalidId }))),
			"DOCX_RELATIONSHIP_INVALID",
		);
		const unicodeId = `<Relationships xmlns="${TRANSITIONAL_PACKAGE_RELATIONSHIPS_NAMESPACE}"><Relationship Id="名·1" Type="${TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP}" Target="word/document.xml"/></Relationships>`;
		expect(resolveDocx(PackageArchive.open(docx({ relationshipsXml: unicodeId }))).mainPart.path).toBe(
			"word/document.xml",
		);
	});

	it("accepts valid ZIP version boundaries and rejects unsupported versions and empty deflate data", () => {
		for (const version of [10, 15, 20]) {
			const stored = storedZip([["a.txt", text("x")]]);
			const record = records(stored)[0];
			write16(stored, record.central + 6, version);
			write16(stored, record.local + 4, version);
			expect(PackageArchive.open(stored).read("a.txt")).toEqual(text("x"));
		}
		const deflated = copy(deflatedZip("a.txt", text("hello")));
		const deflatedRecord = records(deflated)[0];
		write16(deflated, deflatedRecord.central + 6, 20);
		write16(deflated, deflatedRecord.local + 4, 20);
		expect(PackageArchive.open(deflated).read("a.txt")).toEqual(text("hello"));

		const tooNew = storedZip([["a.txt", text("x")]]);
		const tooNewRecord = records(tooNew)[0];
		write16(tooNew, tooNewRecord.central + 6, 21);
		write16(tooNew, tooNewRecord.local + 4, 21);
		expectCode(() => PackageArchive.open(tooNew), "ZIP_VERSION_INVALID");
		const emptyDeflate = copy(deflatedZip("a.txt", text("hello")));
		const emptyDeflateRecord = records(emptyDeflate)[0];
		write32(emptyDeflate, emptyDeflateRecord.central + 20, 0);
		write32(emptyDeflate, emptyDeflateRecord.local + 18, 0);
		expectCode(() => PackageArchive.open(emptyDeflate), "ZIP_DECOMPRESSION_FAILED");
	});

	it("requires UTF-8 flags for Unicode names and rejects Unicode Path extras", () => {
		const unicode = copy(zip([["café.txt", text("x")]]));
		for (const record of records(unicode)) {
			write16(unicode, record.central + 8, read16(unicode, record.central + 8) | 0x0800);
			write16(unicode, record.local + 6, read16(unicode, record.local + 6) | 0x0800);
		}
		expect(PackageArchive.open(unicode).read("café.txt")).toEqual(text("x"));
		const missingFlag = copy(unicode);
		for (const record of records(missingFlag)) {
			write16(missingFlag, record.central + 8, read16(missingFlag, record.central + 8) & ~0x0800);
			write16(missingFlag, record.local + 6, read16(missingFlag, record.local + 6) & ~0x0800);
		}
		expectCode(() => PackageArchive.open(missingFlag), "ZIP_FILENAME_ENCODING_UNSUPPORTED");
		expectCode(() => PackageArchive.open(withCentralExtra(unicode, 0x7075)), "ZIP_UNICODE_PATH_UNSUPPORTED");
		expectCode(() => PackageArchive.open(withLocalExtra(unicode, 0x7075)), "ZIP_UNICODE_PATH_UNSUPPORTED");
	});

	it("rejects a stored method with zero compressed bytes", () => {
		const stored = storedZip([["a.txt", text("x")]]);
		const record = records(stored)[0];
		write16(stored, record.central + 10, 8);
		write16(stored, record.local + 8, 8);
		write32(stored, record.central + 20, 0);
		write32(stored, record.local + 18, 0);
		expectCode(() => PackageArchive.open(stored), "ZIP_DECOMPRESSION_FAILED");
	});
});
it("decodes predefined and numeric XML references in target attributes", () => {
	const target = "custom/a&b.xml";
	const contentTypes = `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Default Extension="bin" ContentType="application/x&quot;&lt;&gt;&apos;"/><Override PartName="/${escapedAttribute(target)}" ContentType="${WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE}"/></Types>`;
	const relationships = `<Relationships xmlns="${TRANSITIONAL_PACKAGE_RELATIONSHIPS_NAMESPACE}"><Relationship Id="rId1" Type="${TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP}" Target="custom/a&amp;b.xml" TargetMode="Internal"/></Relationships>`;
	expect(
		resolveDocx(PackageArchive.open(docx({ target, contentTypesXml: contentTypes, relationshipsXml: relationships })))
			.mainPart.path,
	).toBe(target);

	const numericTarget = "custom/a b.xml";
	const numericContentTypes = `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/custom/a&#x20;b.xml" ContentType="${WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE}"/></Types>`;
	const numericRelationships = `<Relationships xmlns="${TRANSITIONAL_PACKAGE_RELATIONSHIPS_NAMESPACE}"><Relationship Id="rId1" Type="${TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP}" Target="custom/a&#32;b.xml"/></Relationships>`;
	expect(
		resolveDocx(
			PackageArchive.open(
				docx({
					target: numericTarget,
					contentTypesXml: numericContentTypes,
					relationshipsXml: numericRelationships,
				}),
			),
		).mainPart.path,
	).toBe(numericTarget);
});

it("requires supported namespace bindings for roots and children", () => {
	const evilRoot = `<evil:Types xmlns:evil="urn:evil"><evil:Override PartName="/word/document.xml" ContentType="${WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE}"/></evil:Types>`;
	expectCode(() => resolveDocx(PackageArchive.open(docx({ contentTypesXml: evilRoot }))), "DOCX_CONTENT_TYPE_INVALID");
	const evilChild = `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><evil:Override xmlns:evil="urn:evil" PartName="/word/document.xml" ContentType="${WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE}"/></Types>`;
	expectCode(
		() => resolveDocx(PackageArchive.open(docx({ contentTypesXml: evilChild }))),
		"DOCX_CONTENT_TYPE_INVALID",
	);
	const evilRelationships = `<evil:Relationships xmlns:evil="urn:evil"><evil:Relationship Type="${TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP}" Target="word/document.xml"/></evil:Relationships>`;
	expectCode(
		() => resolveDocx(PackageArchive.open(docx({ relationshipsXml: evilRelationships }))),
		"DOCX_RELATIONSHIP_INVALID",
	);
});

it("accepts Strict officeDocument type with the standard package namespace", () => {
	expect(STRICT_OFFICE_DOCUMENT_RELATIONSHIP).toBe(
		"http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument",
	);
	expect(
		resolveDocx(
			PackageArchive.open(
				docx({
					packageNamespace: TRANSITIONAL_PACKAGE_RELATIONSHIPS_NAMESPACE,
					relationshipType: STRICT_OFFICE_DOCUMENT_RELATIONSHIP,
				}),
			),
		).mainPart.path,
	).toBe("word/document.xml");
	expectCode(
		() =>
			resolveDocx(
				PackageArchive.open(
					docx({
						packageNamespace: "http://purl.oclc.org/ooxml/package/relationships",
						relationshipType: STRICT_OFFICE_DOCUMENT_RELATIONSHIP,
					}),
				),
			),
		"DOCX_RELATIONSHIP_INVALID",
	);
});

it("uses defaults, override precedence, and rejects duplicate content type declarations", () => {
	const defaultOnly = `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Default Extension="xml" ContentType="${WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE}"/></Types>`;
	expect(resolveDocx(PackageArchive.open(docx({ contentTypesXml: defaultOnly }))).mainPart.path).toBe(
		"word/document.xml",
	);
	const overrideWins = `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE}"/></Types>`;
	expect(resolveDocx(PackageArchive.open(docx({ contentTypesXml: overrideWins }))).mainPart.path).toBe(
		"word/document.xml",
	);
	const duplicateDefault = `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Default Extension="xml" ContentType="application/xml"/><Default Extension="XML" ContentType="text/xml"/></Types>`;
	expectCode(
		() => resolveDocx(PackageArchive.open(docx({ contentTypesXml: duplicateDefault }))),
		"DOCX_CONTENT_TYPE_INVALID",
	);
	const duplicateOverride = `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/word/document.xml" ContentType="${WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE}"/><Override PartName="/word/document.xml" ContentType="application/xml"/></Types>`;
	expectCode(
		() => resolveDocx(PackageArchive.open(docx({ contentTypesXml: duplicateOverride }))),
		"DOCX_CONTENT_TYPE_INVALID",
	);
});

it("validates exact relationship modes, URI syntax, dot segments, and case", () => {
	expect(resolveDocx(PackageArchive.open(docx({ targetMode: "Internal" }))).mainPart.path).toBe("word/document.xml");
	expect(resolveDocx(PackageArchive.open(docx({ relationshipTarget: "word/./document.xml" }))).mainPart.path).toBe(
		"word/document.xml",
	);
	expect(resolveDocx(PackageArchive.open(docx({ relationshipTarget: "a/../word/document.xml" }))).mainPart.path).toBe(
		"word/document.xml",
	);
	expectCode(() => resolveDocx(PackageArchive.open(docx({ targetMode: "Bogus" }))), "DOCX_RELATIONSHIP_INVALID");
	expectCode(
		() => resolveDocx(PackageArchive.open(docx({ relationshipTarget: "mailto:word@example.test" }))),
		"DOCX_TARGET_INVALID",
	);
	expectCode(
		() => resolveDocx(PackageArchive.open(docx({ relationshipTarget: "word/%2Fdocument.xml" }))),
		"DOCX_TARGET_INVALID",
	);
	expectCode(
		() => resolveDocx(PackageArchive.open(docx({ relationshipTarget: "word/%2e%2e/document.xml" }))),
		"DOCX_TARGET_INVALID",
	);
	expectCode(
		() => resolveDocx(PackageArchive.open(docx({ relationshipTarget: "Word/document.xml" }))),
		"DOCX_MAIN_PART_MISSING",
	);
});

it("rejects missing manifest, relationships, main part, and content type", () => {
	const main = text("<w:document/>");
	const rel = text(
		`<Relationships xmlns="${TRANSITIONAL_PACKAGE_RELATIONSHIPS_NAMESPACE}"><Relationship Type="${TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP}" Target="word/document.xml"/></Relationships>`,
	);
	expectCode(
		() =>
			resolveDocx(
				PackageArchive.open(
					zip([
						["_rels/.rels", rel],
						["word/document.xml", main],
					]),
				),
			),
		"DOCX_MISSING_CONTENT_TYPES",
	);
	const types = text(
		`<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/word/document.xml" ContentType="${WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE}"/></Types>`,
	);
	expectCode(
		() =>
			resolveDocx(
				PackageArchive.open(
					zip([
						["[Content_Types].xml", types],
						["word/document.xml", main],
					]),
				),
			),
		"DOCX_MISSING_ROOT_RELATIONSHIPS",
	);
	expectCode(() => resolveDocx(PackageArchive.open(docx({ includeMain: false }))), "DOCX_MAIN_PART_MISSING");
	const noType = `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"/>`;
	expectCode(
		() => resolveDocx(PackageArchive.open(docx({ contentTypesXml: noType }))),
		"DOCX_MAIN_CONTENT_TYPE_INVALID",
	);
});

it("rejects XML entities, oversize XML, and excessive nesting", () => {
	const unknown = `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/word/document.xml" ContentType="&unknown;"/></Types>`;
	expectCode(() => resolveDocx(PackageArchive.open(docx({ contentTypesXml: unknown }))), "XML_ENTITY_FORBIDDEN");
	const invalidNumeric = `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/word/document.xml" ContentType="&#0;"/></Types>`;
	expectCode(
		() => resolveDocx(PackageArchive.open(docx({ contentTypesXml: invalidNumeric }))),
		"XML_ENTITY_FORBIDDEN",
	);
	const large = `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/word/document.xml" ContentType="${WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE}"/><Description>${"x".repeat(16 * 1024 * 1024)}</Description></Types>`;
	const largeRelationships = `<Relationships xmlns="${TRANSITIONAL_PACKAGE_RELATIONSHIPS_NAMESPACE}"><Relationship Id="rId1" Type="${TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP}" Target="word/document.xml"/></Relationships>`;
	const largeArchive = storedZip([
		["[Content_Types].xml", text(large)],
		["_rels/.rels", text(largeRelationships)],
		["word/document.xml", text("<w:document/>")],
	]);
	expectCode(() => resolveDocx(PackageArchive.open(largeArchive)), "XML_TOO_LARGE");
	const nested = `${"<x>".repeat(110)}value${"</x>".repeat(110)}`;
	const deeplyNested = `<Types xmlns="${CONTENT_TYPES_NAMESPACE}">${nested}</Types>`;
	expectCode(() => resolveDocx(PackageArchive.open(docx({ contentTypesXml: deeplyNested }))), "XML_INVALID");
}, 20_000);

describe("adversarial ZIP metadata", () => {
	it("rejects disk number, invalid flags, versions, and central-directory gaps", () => {
		const disk = copy(zip([["a.txt", text("x")]]));
		write16(disk, records(disk)[0].central + 34, 1);
		expectCode(() => PackageArchive.open(disk), "ZIP_MULTI_DISK");
		const flags = copy(zip([["a.txt", text("x")]]));
		const flagRecord = records(flags)[0];
		write16(flags, flagRecord.central + 8, 0x20);
		write16(flags, flagRecord.local + 6, 0x20);
		expectCode(() => PackageArchive.open(flags), "ZIP_FLAGS_INVALID");
		const version = copy(zip([["a.txt", text("x")]]));
		const versionRecord = records(version)[0];
		write16(version, versionRecord.central + 6, 9);
		write16(version, versionRecord.local + 4, 9);
		expectCode(() => PackageArchive.open(version), "ZIP_VERSION_INVALID");
		const original = zip([["a.txt", text("x")]]);
		const end = eocd(original);
		const gap = new Uint8Array(original.length + 4);
		gap.set(original.subarray(0, end));
		gap.set(text("GAP!"), end);
		gap.set(original.subarray(end), end + 4);
		expectCode(() => PackageArchive.open(gap), "ZIP_CENTRAL_DIRECTORY_TRAILING_DATA");
	});

	it("rejects central/local names and ranges that disagree", () => {
		const name = copy(zip([["a.txt", text("x")]]));
		const nameRecord = records(name)[0];
		name.set(text("b.txt"), nameRecord.central + 46);
		expectCode(() => PackageArchive.open(name), "ZIP_LOCAL_CENTRAL_MISMATCH");
		const range = copy(zip([["a.txt", text("x")]]));
		const rangeRecord = records(range)[0];
		write32(range, rangeRecord.central + 20, 0xffffffff);
		write32(range, rangeRecord.local + 18, 0xffffffff);
		expectCode(() => PackageArchive.open(range), "ZIP_ENTRY_RANGE_INVALID");
		const extra = copy(zip([["a.txt", text("x")]]));
		const extraRecord = records(extra)[0];
		write16(extra, extraRecord.central + 30, 1);
		expectCode(() => PackageArchive.open(extra), "ZIP_CENTRAL_DIRECTORY_INVALID");
	});

	it("detects overlapping valid local entry ranges", () => {
		const original = storedZip([
			["first.bin", new Uint8Array(256)],
			["second.bin", text("x")],
		]);
		const result = copy(original);
		const locations = records(result);
		const first = locations[0];
		const second = locations[1];
		const inserted = first.data + 8;
		const secondEnd = second.data + second.compressedSize;
		result.set(original.subarray(second.local, secondEnd), inserted);
		write32(result, second.central + 42, inserted);
		const firstData = result.subarray(first.data, first.data + first.compressedSize);
		const checksum = crc32(firstData);
		write32(result, first.central + 16, checksum);
		write32(result, first.local + 14, checksum);
		expectCode(() => PackageArchive.open(result), "ZIP_ENTRY_OVERLAP");
	});

	it("covers archive budget, directory, local-header, and decompression branches", () => {
		const base = zip([["a.txt", text("x")]]);
		expect(PackageArchive.from(base).entries()).toHaveLength(1);
		expectCode(() => PackageArchive.open(base, { maxArchiveBytes: 0 }), "ARCHIVE_LIMIT_INVALID");
		expectCode(() => PackageArchive.open(base, { maxEntries: 1.5 }), "ARCHIVE_LIMIT_INVALID");
		expectCode(() => PackageArchive.open(base, { maxEntries: Number.POSITIVE_INFINITY }), "ARCHIVE_LIMIT_INVALID");
		expectCode(() => PackageArchive.open(base, { maxEntries: 10_001 }), "ARCHIVE_LIMIT_INVALID");
		expectCode(() => PackageArchive.open(base, { maxCompressionRatio: 0 }), "ARCHIVE_LIMIT_INVALID");
		expectCode(
			() => PackageArchive.open(base, { maxCompressionRatio: Number.POSITIVE_INFINITY }),
			"ARCHIVE_LIMIT_INVALID",
		);
		expectCode(() => PackageArchive.open(base, { maxCompressionRatio: 201 }), "ARCHIVE_LIMIT_INVALID");

		const noEocdZip64 = new Uint8Array(4);
		write32(noEocdZip64, 0, 0x06064b50);
		expectCode(() => PackageArchive.open(noEocdZip64), "ZIP64_UNSUPPORTED");
		const disk = copy(base);
		write16(disk, eocd(disk) + 4, 1);
		expectCode(() => PackageArchive.open(disk), "ZIP_MULTI_DISK");
		const countMismatch = copy(base);
		write16(countMismatch, eocd(countMismatch) + 8, 2);
		expectCode(() => PackageArchive.open(countMismatch), "ZIP_MULTI_DISK");
		const countRange = copy(base);
		write16(countRange, eocd(countRange) + 8, 2);
		write16(countRange, eocd(countRange) + 10, 2);
		expectCode(() => PackageArchive.open(countRange), "ZIP_CENTRAL_DIRECTORY_INVALID");
		const centralRange = copy(base);
		write32(centralRange, eocd(centralRange) + 12, read32(centralRange, eocd(centralRange) + 12) + 1);
		expectCode(() => PackageArchive.open(centralRange), "ZIP_CENTRAL_DIRECTORY_INVALID");
		const centralSignature = copy(base);
		write32(centralSignature, records(centralSignature)[0].central, 0);
		expectCode(() => PackageArchive.open(centralSignature), "ZIP_CENTRAL_DIRECTORY_INVALID");
		const zip64Extra = withCentralZip64Extra(base);
		expectCode(() => PackageArchive.open(zip64Extra), "ZIP64_UNSUPPORTED");

		const localRange = copy(base);
		const localRangeRecord = records(localRange)[0];
		write32(localRange, localRangeRecord.central + 42, read32(localRange, eocd(localRange) + 16));
		expectCode(() => PackageArchive.open(localRange), "ZIP_ENTRY_RANGE_INVALID");
		const localSignature = copy(base);
		write32(localSignature, records(localSignature)[0].local, 0);
		expectCode(() => PackageArchive.open(localSignature), "ZIP_LOCAL_HEADER_INVALID");
		const localHeaderRange = copy(base);
		write16(localHeaderRange, records(localHeaderRange)[0].local + 26, 0xffff);
		expectCode(() => PackageArchive.open(localHeaderRange), "ZIP_ENTRY_RANGE_INVALID");
		const localName = copy(base);
		write16(localName, records(localName)[0].local + 26, 4);
		expectCode(() => PackageArchive.open(localName), "ZIP_LOCAL_CENTRAL_MISMATCH");
		const localExtra = copy(base);
		write16(localExtra, records(localExtra)[0].local + 28, 4);
		expectCode(() => PackageArchive.open(localExtra), "ZIP_ENTRY_RANGE_INVALID");

		const storedSize = storedZip([["a.txt", text("x")]]);
		const storedSizeRecord = records(storedSize)[0];
		write32(storedSize, storedSizeRecord.central + 24, 2);
		write32(storedSize, storedSizeRecord.local + 22, 2);
		expectCode(() => PackageArchive.open(storedSize), "ZIP_DECOMPRESSION_FAILED");
		const storedCrc = storedZip([["a.txt", text("x")]]);
		const storedCrcRecord = records(storedCrc)[0];
		write32(storedCrc, storedCrcRecord.central + 16, 0);
		write32(storedCrc, storedCrcRecord.local + 14, 0);
		expectCode(() => PackageArchive.open(storedCrc), "ZIP_CRC_MISMATCH");
		const emptyDeflate = storedZip([["empty", new Uint8Array()]]);
		const emptyRecord = records(emptyDeflate)[0];
		write16(emptyDeflate, emptyRecord.central + 10, 8);
		write16(emptyDeflate, emptyRecord.local + 8, 8);
		expectCode(() => PackageArchive.open(emptyDeflate), "ZIP_DECOMPRESSION_FAILED");
		const deflateSize = copy(deflatedZip("a.txt", text("hello")));
		const deflateSizeRecord = records(deflateSize)[0];
		write32(deflateSize, deflateSizeRecord.central + 24, 6);
		write32(deflateSize, deflateSizeRecord.local + 22, 6);
		expectCode(() => PackageArchive.open(deflateSize), "ZIP_DECOMPRESSION_FAILED");
		const deflateCrc = copy(deflatedZip("a.txt", text("hello")));
		const deflateCrcRecord = records(deflateCrc)[0];
		write32(deflateCrc, deflateCrcRecord.central + 16, 0);
		write32(deflateCrc, deflateCrcRecord.local + 14, 0);
		expectCode(() => PackageArchive.open(deflateCrc), "ZIP_CRC_MISMATCH");
		const malformedDeflate = copy(deflatedZip("a.txt", text("hello")));
		const malformedRecord = records(malformedDeflate)[0];
		malformedDeflate.fill(0xff, malformedRecord.data, malformedRecord.data + malformedRecord.compressedSize);
		expectCode(() => PackageArchive.open(malformedDeflate), "ZIP_DECOMPRESSION_FAILED");
		expectCode(() => PackageArchive.open(base).read("missing.txt"), "ARCHIVE_INVALID");
	});

	it("covers XML roots, namespace prefixes, references, and resolver rejection paths", () => {
		const prefixedTypes = `<ct:Types xmlns:ct="${CONTENT_TYPES_NAMESPACE}"><ct:Override PartName="/word/document.xml" ContentType="${WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE}"/></ct:Types>`;
		const prefixedRelationships = `<pr:Relationships xmlns:pr="${TRANSITIONAL_PACKAGE_RELATIONSHIPS_NAMESPACE}"><pr:Relationship Id="rId1" Type="${TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP}" Target="word/document.xml"/></pr:Relationships>`;
		expect(
			resolveDocx(
				PackageArchive.open(docx({ contentTypesXml: prefixedTypes, relationshipsXml: prefixedRelationships })),
			).mainPart.path,
		).toBe("word/document.xml");
		const entityDeclaration = `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><!ENTITY x "bad"></Types>`;
		expectCode(
			() => resolveDocx(PackageArchive.open(docx({ contentTypesXml: entityDeclaration }))),
			"XML_ENTITY_FORBIDDEN",
		);
		const invalidUtf8 = storedZip([
			["[Content_Types].xml", new Uint8Array([0xff])],
			[
				"_rels/.rels",
				text(
					`<Relationships xmlns="${TRANSITIONAL_PACKAGE_RELATIONSHIPS_NAMESPACE}"><Relationship Id="rId1" Type="${TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP}" Target="word/document.xml"/></Relationships>`,
				),
			],
			["word/document.xml", text("<w:document/>")],
		]);
		expectCode(() => resolveDocx(PackageArchive.open(invalidUtf8)), "XML_INVALID");
		const scalarRoot = `<Types xmlns="${CONTENT_TYPES_NAMESPACE}">text</Types>`;
		expectCode(
			() => resolveDocx(PackageArchive.open(docx({ contentTypesXml: scalarRoot }))),
			"DOCX_MAIN_CONTENT_TYPE_INVALID",
		);
		const scalarChild = `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override>text</Override></Types>`;
		expectCode(
			() => resolveDocx(PackageArchive.open(docx({ contentTypesXml: scalarChild }))),
			"DOCX_CONTENT_TYPE_INVALID",
		);
		const missingAttribute = `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/word/document.xml"/></Types>`;
		expectCode(
			() => resolveDocx(PackageArchive.open(docx({ contentTypesXml: missingAttribute }))),
			"DOCX_CONTENT_TYPE_INVALID",
		);
		for (const partName of ["word/document.xml", "/", "/../document.xml"]) {
			const types = `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="${partName}" ContentType="${WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE}"/></Types>`;
			expectCode(
				() => resolveDocx(PackageArchive.open(docx({ contentTypesXml: types }))),
				"DOCX_CONTENT_TYPE_INVALID",
			);
		}
		const missingNamespace = '<Types><Override PartName="/word/document.xml" ContentType="application/xml"/></Types>';
		expectCode(
			() => resolveDocx(PackageArchive.open(docx({ contentTypesXml: missingNamespace }))),
			"DOCX_CONTENT_TYPE_INVALID",
		);
		const invalidDefault = `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Default Extension="a/b" ContentType="application/xml"/></Types>`;
		expectCode(
			() => resolveDocx(PackageArchive.open(docx({ contentTypesXml: invalidDefault }))),
			"DOCX_CONTENT_TYPE_INVALID",
		);
		const missingDefaultAttribute = `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Default Extension="xml"/></Types>`;
		expectCode(
			() => resolveDocx(PackageArchive.open(docx({ contentTypesXml: missingDefaultAttribute }))),
			"DOCX_CONTENT_TYPE_INVALID",
		);
		const noExtensionTypes = `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Default Extension="xml" ContentType="${WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE}"/></Types>`;
		expectCode(
			() => resolveDocx(PackageArchive.open(docx({ target: "word/document", contentTypesXml: noExtensionTypes }))),
			"DOCX_MAIN_CONTENT_TYPE_INVALID",
		);
		const missingTarget = `<Relationships xmlns="${TRANSITIONAL_PACKAGE_RELATIONSHIPS_NAMESPACE}"><Relationship Id="rId1" Type="${TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP}"/></Relationships>`;
		expectCode(
			() => resolveDocx(PackageArchive.open(docx({ relationshipsXml: missingTarget }))),
			"DOCX_RELATIONSHIP_INVALID",
		);
		expectCode(() => resolveDocx(PackageArchive.open(docx({ targetMode: "internal" }))), "DOCX_RELATIONSHIP_INVALID");
		expectCode(() => resolveDocx(PackageArchive.open(docx({ targetMode: "external" }))), "DOCX_RELATIONSHIP_INVALID");
		for (const target of [
			"word/document.xml?query",
			"word/document.xml#fragment",
			"http://example.test/document.xml",
			"word/%ZZ/document.xml",
			"word/%3Fdocument.xml",
			"word/%23document.xml",
			"word/%5Cdocument.xml",
			"word/%00document.xml",
			"word//document.xml",
			".",
			"word\\document.xml",
		]) {
			expectCode(
				() => resolveDocx(PackageArchive.open(docx({ relationshipTarget: target }))),
				"DOCX_TARGET_INVALID",
			);
		}
		for (const reference of ["&#x110000;", "&#xD800;", "&#x1;"]) {
			const types = `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/word/document.xml" ContentType="${reference}"/></Types>`;
			expectCode(() => resolveDocx(PackageArchive.open(docx({ contentTypesXml: types }))), "XML_ENTITY_FORBIDDEN");
		}
	});
});
