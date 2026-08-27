import { type ZipOptions, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
	OfficeEngineError,
	PackageArchive,
	resolveDocx,
	STRICT_OFFICE_DOCUMENT_RELATIONSHIP,
	TRANSITIONAL_OFFICE_DOCUMENT_RELATIONSHIP,
	verifyReplacement,
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

interface ZipRecordLocation {
	readonly path: string;
	readonly central: number;
	readonly local: number;
	readonly data: number;
}

function records(data: Uint8Array): ZipRecordLocation[] {
	const end = findEocd(data);
	let cursor = readU32(data, end + 16);
	const result: ZipRecordLocation[] = [];
	for (let index = 0; index < readU16(data, end + 10); index += 1) {
		const nameLength = readU16(data, cursor + 28);
		const extraLength = readU16(data, cursor + 30);
		const local = readU32(data, cursor + 42);
		const name = textDecoder.decode(data.subarray(cursor + 46, cursor + 46 + nameLength));
		const localNameLength = readU16(data, local + 26);
		const localExtraLength = readU16(data, local + 28);
		result.push({ path: name, central: cursor, local, data: local + 30 + localNameLength + localExtraLength });
		cursor += 46 + nameLength + extraLength + readU16(data, cursor + 32);
	}
	return result;
}

function metadataZip(level: 0 | 9, targetPosition: "first" | "middle" | "last"): Uint8Array {
	const options: ZipOptions = {
		level,
		extra: { 51966: bytes("archive-extra") },
		comment: "entry-comment",
	};
	const files: ReadonlyArray<readonly [string, [Uint8Array, ZipOptions]]> = [
		["first.bin", [bytes("first"), options]],
		["target.bin", [bytes("target-old"), { ...options, comment: "target-comment" }]],
		["last.bin", [bytes("last"), { ...options, comment: "last-comment" }]],
	];
	const ordered =
		targetPosition === "first"
			? [files[1], files[0], files[2]]
			: targetPosition === "last"
				? [files[0], files[2], files[1]]
				: files;
	const input: Record<string, [Uint8Array, ZipOptions]> = {};
	for (const [name, value] of ordered) input[name] = value;
	const result = zipSync(input);
	const end = findEocd(result);
	const comment = bytes("eocd-comment");
	const withComment = new Uint8Array(result.length + comment.length);
	withComment.set(result.subarray(0, end + 22));
	withComment.set(comment, end + 22);
	writeU16(withComment, end + 20, comment.length);
	return withComment;
}

function reorderCentral(data: Uint8Array, order: readonly number[]): Uint8Array {
	const end = findEocd(data);
	const start = readU32(data, end + 16);
	const centralRecords: Uint8Array[] = [];
	let cursor = start;
	for (let index = 0; index < readU16(data, end + 10); index += 1) {
		const length = 46 + readU16(data, cursor + 28) + readU16(data, cursor + 30) + readU16(data, cursor + 32);
		centralRecords.push(data.slice(cursor, cursor + length));
		cursor += length;
	}
	const result = new Uint8Array(data);
	cursor = start;
	for (const index of order) {
		result.set(centralRecords[index], cursor);
		cursor += centralRecords[index].length;
	}
	return result;
}

function insertOpaque(data: Uint8Array, at: number, opaque: Uint8Array): Uint8Array {
	const result = new Uint8Array(data.length + opaque.length);
	result.set(data.subarray(0, at), 0);
	result.set(opaque, at);
	result.set(data.subarray(at), at + opaque.length);
	const end = findEocd(result);
	const central = readU32(result, end + 16);
	const centralStart = central >= at ? central + opaque.length : central;
	const count = readU16(result, end + 10);
	let cursor = centralStart;
	for (let index = 0; index < count; index += 1) {
		if (readU32(result, cursor) !== CENTRAL) throw new Error("fixture central record not found");
		if (readU32(result, cursor + 42) >= at)
			writeU32(result, cursor + 42, readU32(result, cursor + 42) + opaque.length);
		cursor += 46 + readU16(result, cursor + 28) + readU16(result, cursor + 30) + readU16(result, cursor + 32);
	}
	if (central >= at) writeU32(result, end + 16, central + opaque.length);
	return result;
}

function withOpaqueGaps(data: Uint8Array): Uint8Array {
	let result = data;
	result = insertOpaque(result, 0, bytes("PREAMBLE"));
	let current = records(result).sort((left, right) => left.local - right.local);
	for (let index = current.length - 1; index >= 0; index -= 1) {
		current = records(result).sort((left, right) => left.local - right.local);
		const record = current[index];
		const compressedSize = readU32(result, record.central + 20);
		const localNameLength = readU16(result, record.local + 26);
		const localExtraLength = readU16(result, record.local + 28);
		const end = record.local + 30 + localNameLength + localExtraLength + compressedSize;
		result = insertOpaque(result, end, bytes(`GAP-${index}`));
	}
	const end = findEocd(result);
	const central = readU32(result, end + 16);
	return insertOpaque(result, central, bytes("FINAL-GAP"));
}

function opaqueRanges(data: Uint8Array): Array<readonly [number, number]> {
	const end = findEocd(data);
	const central = readU32(data, end + 16);
	const local = records(data)
		.sort((left, right) => left.local - right.local)
		.map((record) => {
			const compressedSize = readU32(data, record.central + 20);
			return [record.local, record.data + compressedSize] as const;
		});
	const ranges: Array<readonly [number, number]> = [];
	let cursor = 0;
	for (const [start, finish] of local) {
		if (cursor < start) ranges.push([cursor, start]);
		cursor = finish;
	}
	if (cursor < central) ranges.push([cursor, central]);
	return ranges;
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

	it("rejects ZIP64, encryption, malformed data descriptors, and unsupported compression", () => {
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
		expectCode(() => PackageArchive.open(descriptor), "ZIP_ENTRY_RANGE_INVALID");

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

	it("verifies raw ZIP delta across reordered central records and metadata", () => {
		for (const level of [0, 9] as const) {
			for (const targetPosition of ["first", "middle", "last"] as const) {
				const source = reorderCentral(metadataZip(level, targetPosition), [1, 2, 0]);
				const replacement = bytes("target-new-content");
				const output = PackageArchive.open(source).replace("target.bin", replacement);
				expect(verifyReplacement(source, output, "target.bin", replacement).changedEntries).toEqual(["target.bin"]);

				const target = records(output).find((record) => record.path === "target.bin");
				const untouched = records(output).find((record) => record.path === "first.bin");
				if (target === undefined || untouched === undefined) throw new Error("fixture record not found");
				const locations = [target.local, target.central];
				for (const location of locations) {
					const mutated = copied(output);
					mutated[location + (location === target.local ? 10 : 12)] ^= 1;
					expect(() => verifyReplacement(source, mutated, "target.bin", replacement)).toThrow();
				}

				const untouchedLocal = copied(output);
				untouchedLocal[untouched.data] ^= 1;
				expect(() => verifyReplacement(source, untouchedLocal, "target.bin", replacement)).toThrow();
				const untouchedCentral = copied(output);
				untouchedCentral[untouched.central + 38] ^= 1;
				expect(() => verifyReplacement(source, untouchedCentral, "target.bin", replacement)).toThrow();

				const badDisk = copied(output);
				writeU16(badDisk, findEocd(badDisk) + 4, 1);
				expect(() => verifyReplacement(source, badDisk, "target.bin", replacement)).toThrow();
				const badComment = copied(output);
				badComment[findEocd(badComment) + 22] ^= 1;
				expect(() => verifyReplacement(source, badComment, "target.bin", replacement)).toThrow();
			}
		}
	});

	it("proves opaque preamble and local gaps across every replacement layout", () => {
		for (const level of [0, 9] as const) {
			for (const targetPosition of ["first", "middle", "last"] as const) {
				const source = reorderCentral(withOpaqueGaps(metadataZip(level, targetPosition)), [2, 0, 1]);
				for (const replacement of [bytes("short"), bytes("target-new"), bytes("target-content-that-is-longer")]) {
					const output = PackageArchive.open(source).replace("target.bin", replacement);
					expect(() => verifyReplacement(source, output, "target.bin", replacement)).not.toThrow();
					for (const [start] of opaqueRanges(output)) {
						const mutated = copied(output);
						mutated[start] ^= 1;
						expect(() => verifyReplacement(source, mutated, "target.bin", replacement)).toThrow();
					}
				}
			}
		}
	});
});
