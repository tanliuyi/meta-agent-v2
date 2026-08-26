import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
	OfficeEngineError,
	PackageArchive,
	resolveDocx,
	STRICT_OFFICE_DOCUMENT_RELATIONSHIP,
	TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP,
	WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE,
} from "../src/index.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;

function bytes(text: string): Uint8Array {
	return textEncoder.encode(text);
}

function readU16(data: Uint8Array, offset: number): number {
	return data[offset] | (data[offset + 1] << 8);
}

function readU32(data: Uint8Array, offset: number): number {
	return (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
}

function writeU16(data: Uint8Array, offset: number, value: number): void {
	data[offset] = value & 0xff;
	data[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(data: Uint8Array, offset: number, value: number): void {
	data[offset] = value & 0xff;
	data[offset + 1] = (value >>> 8) & 0xff;
	data[offset + 2] = (value >>> 16) & 0xff;
	data[offset + 3] = (value >>> 24) & 0xff;
}

function findEocd(data: Uint8Array): number {
	for (let offset = data.length - 22; offset >= 0; offset -= 1) {
		if (readU32(data, offset) === EOCD && offset + 22 + readU16(data, offset + 20) === data.length) {
			return offset;
		}
	}
	throw new Error("fixture EOCD not found");
}

interface ZipRecord {
	readonly central: number;
	readonly local: number;
}

function firstZipRecord(data: Uint8Array): ZipRecord {
	const central = readU32(data, findEocd(data) + 16);
	if (readU32(data, central) !== CENTRAL) throw new Error("fixture central record not found");
	return { central, local: readU32(data, central + 42) };
}

function zip(files: ReadonlyArray<readonly [string, Uint8Array]>): Uint8Array {
	const input: Record<string, Uint8Array> = {};
	for (const [path, content] of files) input[path] = content;
	return zipSync(input);
}

function deflatedZip(path: string, content: Uint8Array): Uint8Array {
	return zipSync({ [path]: [content, { level: 9 }] });
}

interface DocxFixtureOptions {
	readonly target?: string;
	readonly relationshipType?: string;
	readonly targetMode?: string;
	readonly extraRelationships?: string;
	readonly contentType?: string;
	readonly contentTypesXml?: string;
	readonly relationshipsXml?: string;
}

function docx(options: DocxFixtureOptions = {}): Uint8Array {
	const target = options.target ?? "word/document.xml";
	const contentType = options.contentType ?? WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE;
	const contentTypesXml =
		options.contentTypesXml ??
		`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${target}" ContentType="${contentType}"/></Types>`;
	const relationshipsXml =
		options.relationshipsXml ??
		`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${options.relationshipType ?? TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP}" Target="${target}"${options.targetMode === undefined ? "" : ` TargetMode="${options.targetMode}"`}/>${options.extraRelationships ?? ""}</Relationships>`;
	return zip([
		["[Content_Types].xml", bytes(contentTypesXml)],
		["_rels/.rels", bytes(relationshipsXml)],
		[
			target,
			bytes(
				'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
			),
		],
	]);
}

function copied(data: Uint8Array): Uint8Array {
	return new Uint8Array(data);
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

describe("PackageArchive", () => {
	it("opens generated DOCX, resolves a non-default main part, and preserves no-op bytes", () => {
		const input = docx({ target: "custom/main.xml", relationshipType: STRICT_OFFICE_DOCUMENT_RELATIONSHIP });
		const archive = PackageArchive.open(input);
		expect(resolveDocx(archive).mainPart.path).toBe("custom/main.xml");
		expect(archive.read("custom/main.xml")).toEqual(
			bytes(
				'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
			),
		);
		expect(archive.serialize()).toEqual(input);
		expect(archive.save()).toEqual(input);
		input[0] ^= 0xff;
		expect(archive.serialize()).not.toEqual(input);
	});

	it("isolates input, read, serialize, and entry results", () => {
		const input = zip([["data.txt", bytes("original")]]);
		const archive = PackageArchive.open(input);
		const readResult = archive.read("data.txt");
		readResult[0] = 0;
		const serialized = archive.serialize();
		serialized[0] ^= 0xff;
		const entries = archive.entries();
		const mutableEntry = entries[0] as { path: string };
		mutableEntry.path = "changed";
		expect(textDecoder.decode(archive.read("data.txt"))).toBe("original");
		expect(archive.entries()[0].path).toBe("data.txt");
	});

	it("rejects unsafe paths and NFC/case-insensitive duplicates", () => {
		expectCode(() => PackageArchive.open(zip([["../evil.txt", bytes("x")]])), "ARCHIVE_UNSAFE_PATH");
		expectCode(() => PackageArchive.open(zip([["a\\b.txt", bytes("x")]])), "ARCHIVE_UNSAFE_PATH");
		expectCode(
			() =>
				PackageArchive.open(
					zip([
						["café.txt", bytes("x")],
						["cafe\u0301.txt", bytes("y")],
					]),
				),
			"ARCHIVE_DUPLICATE_PATH",
		);
		expectCode(
			() =>
				PackageArchive.open(
					zip([
						["Data.txt", bytes("x")],
						["data.TXT", bytes("y")],
					]),
				),
			"ARCHIVE_DUPLICATE_PATH",
		);
	});

	it("rejects ZIP64, encryption, data descriptors, and unsupported compression", () => {
		const zip64 = copied(zip([["a.txt", bytes("x")]]));
		writeU16(zip64, findEocd(zip64) + 10, 0xffff);
		expectCode(() => PackageArchive.open(zip64), "ZIP64_UNSUPPORTED");

		const encrypted = copied(zip([["a.txt", bytes("x")]]));
		const encryptedRecord = firstZipRecord(encrypted);
		writeU16(encrypted, encryptedRecord.central + 8, readU16(encrypted, encryptedRecord.central + 8) | 1);
		writeU16(encrypted, encryptedRecord.local + 6, readU16(encrypted, encryptedRecord.local + 6) | 1);
		expectCode(() => PackageArchive.open(encrypted), "ZIP_ENCRYPTED");

		const descriptor = copied(zip([["a.txt", bytes("x")]]));
		const descriptorRecord = firstZipRecord(descriptor);
		writeU16(descriptor, descriptorRecord.central + 8, readU16(descriptor, descriptorRecord.central + 8) | 8);
		writeU16(descriptor, descriptorRecord.local + 6, readU16(descriptor, descriptorRecord.local + 6) | 8);
		expectCode(() => PackageArchive.open(descriptor), "ZIP_DATA_DESCRIPTOR");

		const unsupported = copied(zip([["a.txt", bytes("x")]]));
		const unsupportedRecord = firstZipRecord(unsupported);
		writeU16(unsupported, unsupportedRecord.central + 10, 12);
		writeU16(unsupported, unsupportedRecord.local + 8, 12);
		expectCode(() => PackageArchive.open(unsupported), "ZIP_UNSUPPORTED_COMPRESSION");
	});

	it("enforces archive, entry, path, size, total, ratio, and override budgets", () => {
		const one = zip([["long-name.txt", bytes("1234")]]);
		expectCode(() => PackageArchive.open(one, { maxArchiveBytes: one.length - 1 }), "ARCHIVE_TOO_LARGE");
		expectCode(() => PackageArchive.open(one, { maxPathBytes: 4 }), "ARCHIVE_PATH_TOO_LONG");
		expectCode(
			() =>
				PackageArchive.open(
					zip([
						["a", bytes("1")],
						["b", bytes("2")],
					]),
					{ maxEntries: 1 },
				),
			"ARCHIVE_ENTRY_LIMIT",
		);
		expectCode(() => PackageArchive.open(one, { maxSingleUncompressedBytes: 3 }), "ARCHIVE_SINGLE_SIZE_LIMIT");
		expectCode(
			() =>
				PackageArchive.open(
					zip([
						["a", bytes("12")],
						["b", bytes("34")],
					]),
					{ maxTotalUncompressedBytes: 3 },
				),
			"ARCHIVE_TOTAL_SIZE_LIMIT",
		);
		expectCode(
			() => PackageArchive.open(deflatedZip("a", bytes("a".repeat(512))), { maxCompressionRatio: 1 }),
			"ARCHIVE_COMPRESSION_RATIO_LIMIT",
		);
		expectCode(() => PackageArchive.open(one, { maxArchiveBytes: 128 * 1024 * 1024 + 1 }), "ARCHIVE_LIMIT_INVALID");
	});

	it("rejects CRC mismatch and local/central metadata mismatch", () => {
		const crc = copied(zip([["a.txt", bytes("x")]]));
		const crcRecord = firstZipRecord(crc);
		writeU32(crc, crcRecord.central + 16, 0);
		writeU32(crc, crcRecord.local + 14, 0);
		expectCode(() => PackageArchive.open(crc), "ZIP_CRC_MISMATCH");

		const mismatch = copied(zip([["a.txt", bytes("x")]]));
		const mismatchRecord = firstZipRecord(mismatch);
		writeU32(mismatch, mismatchRecord.central + 24, 2);
		expectCode(() => PackageArchive.open(mismatch), "ZIP_LOCAL_CENTRAL_MISMATCH");
	});

	it("bounds actual streaming deflate output when the central size is forged small", () => {
		const forged = copied(deflatedZip("a.txt", bytes("z".repeat(128 * 1024))));
		const record = firstZipRecord(forged);
		writeU32(forged, record.central + 24, 1);
		writeU32(forged, record.local + 22, 1);
		expectCode(() => PackageArchive.open(forged), "ZIP_DECOMPRESSION_FAILED");
	});
});

describe("DOCX resolver", () => {
	it("accepts Transitional and Strict officeDocument relationships", () => {
		expect(resolveDocx(PackageArchive.open(docx())).mainPart.path).toBe("word/document.xml");
		expect(
			resolveDocx(PackageArchive.open(docx({ relationshipType: STRICT_OFFICE_DOCUMENT_RELATIONSHIP }))).mainPart
				.path,
		).toBe("word/document.xml");
	});

	it("rejects DTD, entity references, external and invalid relationship cases", () => {
		const dtd = `<!DOCTYPE Types [<!ENTITY x "bad">]><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="${WORDPROCESSINGML_DOCUMENT_CONTENT_TYPE}"/></Types>`;
		expectCode(() => resolveDocx(PackageArchive.open(docx({ contentTypesXml: dtd }))), "XML_DTD_FORBIDDEN");
		const entity = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="&evil;"/></Types>`;
		expectCode(() => resolveDocx(PackageArchive.open(docx({ contentTypesXml: entity }))), "XML_ENTITY_FORBIDDEN");
		expectCode(
			() => resolveDocx(PackageArchive.open(docx({ targetMode: "External" }))),
			"DOCX_EXTERNAL_RELATIONSHIP",
		);
		expectCode(
			() => resolveDocx(PackageArchive.open(docx({ relationshipsXml: "<Relationships><Relationship" }))),
			"XML_INVALID",
		);
		const unsafeTargetRelationships = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP}" Target="../document.xml"/></Relationships>`;
		expectCode(
			() => resolveDocx(PackageArchive.open(docx({ relationshipsXml: unsafeTargetRelationships }))),
			"DOCX_TARGET_INVALID",
		);
	});

	it("rejects missing and duplicate officeDocument relationships", () => {
		const noOfficeDocument = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="urn:other" Target="word/document.xml"/></Relationships>`;
		expectCode(
			() => resolveDocx(PackageArchive.open(docx({ relationshipsXml: noOfficeDocument }))),
			"DOCX_MISSING_OFFICE_DOCUMENT",
		);
		const duplicate = `<Relationship Id="rId2" Type="${TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP}" Target="word/document.xml"/>`;
		expectCode(
			() => resolveDocx(PackageArchive.open(docx({ extraRelationships: duplicate }))),
			"DOCX_DUPLICATE_OFFICE_DOCUMENT",
		);
	});

	it("rejects a macro-enabled main content type", () => {
		expectCode(
			() =>
				resolveDocx(
					PackageArchive.open(docx({ contentType: "application/vnd.ms-word.document.macroEnabled.main+xml" })),
				),
			"DOCX_MAIN_CONTENT_TYPE_INVALID",
		);
	});
});
