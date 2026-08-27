import { deflateSync, Inflate } from "fflate";
import { OfficeEngineError, officeError } from "./errors.ts";

export interface ArchiveLimits {
	readonly maxArchiveBytes: number;
	readonly maxEntries: number;
	readonly maxSingleUncompressedBytes: number;
	readonly maxTotalUncompressedBytes: number;
	readonly maxCompressionRatio: number;
	readonly maxPathBytes: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = Object.freeze({
	maxArchiveBytes: 128 * 1024 * 1024,
	maxEntries: 10_000,
	maxSingleUncompressedBytes: 64 * 1024 * 1024,
	maxTotalUncompressedBytes: 512 * 1024 * 1024,
	maxCompressionRatio: 200,
	maxPathBytes: 1024,
});

export interface PackageArchiveEntry {
	readonly path: string;
	readonly compressedSize: number;
	readonly uncompressedSize: number;
	readonly compressionMethod: 0 | 8;
	readonly crc32: number;
}

type InternalEntry = PackageArchiveEntry & {
	readonly centralHeaderOffset: number;
	readonly centralRecordLength: number;
	readonly flags: number;
	readonly localHeaderOffset: number;
	readonly dataOffset: number;
};

interface ParsedArchive {
	readonly centralOffset: number;
	readonly centralSize: number;
	readonly eocdOffset: number;
	readonly entries: ReadonlyArray<InternalEntry>;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const UTF8_ENCODER = new TextEncoder();
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const DEFLATE_METHOD = 8;
const STORED_METHOD = 0;
const UTF8_FLAG = 0x0800;
const DEFLATE_OPTION_FLAGS = 0x0006;
const REWRITE_ENTRY = Symbol("rewriteEntry");

function readU16(bytes: Uint8Array, offset: number): number {
	return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
	bytes[offset] = value & 0xff;
	bytes[offset + 1] = (value >>> 8) & 0xff;
	bytes[offset + 2] = (value >>> 16) & 0xff;
	bytes[offset + 3] = (value >>> 24) & 0xff;
}

function hasRange(bytes: Uint8Array, offset: number, length: number, limit = bytes.length): boolean {
	return offset >= 0 && length >= 0 && offset <= limit && length <= limit - offset;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function decodeName(bytes: Uint8Array): string {
	try {
		return UTF8.decode(bytes);
	} catch {
		throw officeError("ARCHIVE_UNSAFE_PATH");
	}
}

function validateFilenameEncoding(bytes: Uint8Array, flags: number): void {
	if (bytes.some((byte) => byte >= 0x80) && (flags & UTF8_FLAG) === 0) {
		throw officeError("ZIP_FILENAME_ENCODING_UNSUPPORTED");
	}
}

function parseExtraFields(bytes: Uint8Array): void {
	let offset = 0;
	while (offset < bytes.length) {
		if (!hasRange(bytes, offset, 4)) throw officeError("ZIP_CENTRAL_DIRECTORY_INVALID");
		const fieldId = readU16(bytes, offset);
		const length = readU16(bytes, offset + 2);
		offset += 4;
		if (!hasRange(bytes, offset, length)) throw officeError("ZIP_CENTRAL_DIRECTORY_INVALID");
		if (fieldId === 0x0001) throw officeError("ZIP64_UNSUPPORTED");
		if (fieldId === 0x7075) throw officeError("ZIP_UNICODE_PATH_UNSUPPORTED");
		offset += length;
	}
}

function validateLimits(overrides: Partial<ArchiveLimits> | undefined): ArchiveLimits {
	const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...overrides };
	const integerKeys: ReadonlyArray<keyof ArchiveLimits> = [
		"maxArchiveBytes",
		"maxEntries",
		"maxSingleUncompressedBytes",
		"maxTotalUncompressedBytes",
		"maxPathBytes",
	];
	for (const key of integerKeys) {
		const value = limits[key];
		if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0 || value > DEFAULT_ARCHIVE_LIMITS[key]) {
			throw officeError("ARCHIVE_LIMIT_INVALID");
		}
	}
	if (
		!Number.isFinite(limits.maxCompressionRatio) ||
		limits.maxCompressionRatio <= 0 ||
		limits.maxCompressionRatio > DEFAULT_ARCHIVE_LIMITS.maxCompressionRatio
	) {
		throw officeError("ARCHIVE_LIMIT_INVALID");
	}
	return limits;
}

function pathKey(path: string): string {
	return path.toLowerCase();
}

export function normalizeOpcPath(path: string): string {
	if (typeof path !== "string" || path.length === 0 || path.includes("\u0000")) {
		throw officeError("ARCHIVE_UNSAFE_PATH");
	}
	if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path) || path.includes("\\")) {
		throw officeError("ARCHIVE_UNSAFE_PATH");
	}
	const normalized = path.normalize("NFC");
	const segments = normalized.split("/");
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
		throw officeError("ARCHIVE_UNSAFE_PATH");
	}
	if (UTF8_ENCODER.encode(normalized).length > DEFAULT_ARCHIVE_LIMITS.maxPathBytes) {
		throw officeError("ARCHIVE_PATH_TOO_LONG");
	}
	return normalized;
}

function normalizePathWithLimit(path: string, maxPathBytes: number): string {
	const normalized = normalizeOpcPath(path);
	if (UTF8_ENCODER.encode(normalized).length > maxPathBytes) throw officeError("ARCHIVE_PATH_TOO_LONG");
	return normalized;
}

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
	const lowerBound = Math.max(0, bytes.length - (22 + 0xffff));
	for (let offset = bytes.length - 22; offset >= lowerBound; offset -= 1) {
		if (!hasRange(bytes, offset, 22) || readU32(bytes, offset) !== EOCD_SIGNATURE) continue;
		const commentLength = readU16(bytes, offset + 20);
		if (offset + 22 + commentLength === bytes.length) return offset;
	}
	for (let offset = 0; offset + 4 <= bytes.length; offset += 1) {
		const signature = readU32(bytes, offset);
		if (signature === ZIP64_EOCD_SIGNATURE || signature === ZIP64_LOCATOR_SIGNATURE) {
			throw officeError("ZIP64_UNSUPPORTED");
		}
	}
	throw officeError("ARCHIVE_INVALID");
}

function validateFlags(flags: number, method: number): void {
	const allowed = method === DEFLATE_METHOD ? UTF8_FLAG | DEFLATE_OPTION_FLAGS : UTF8_FLAG;
	if ((flags & ~allowed) !== 0) throw officeError("ZIP_FLAGS_INVALID");
}

function validateVersion(localVersion: number, centralVersion: number, method: number): void {
	const minimum = method === STORED_METHOD ? 10 : 20;
	const validVersion =
		method === STORED_METHOD
			? localVersion >= minimum && centralVersion >= minimum
			: localVersion === minimum && centralVersion === minimum;
	if (!validVersion || localVersion > 20 || centralVersion > 20 || localVersion !== centralVersion) {
		throw officeError("ZIP_VERSION_INVALID");
	}
}

function decompressEntry(bytes: Uint8Array, entry: InternalEntry, maxSingleUncompressedBytes: number): Uint8Array {
	const compressed = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
	try {
		if (entry.compressionMethod === DEFLATE_METHOD && compressed.length === 0) {
			throw officeError("ZIP_DECOMPRESSION_FAILED");
		}
		if (entry.compressionMethod === STORED_METHOD) {
			const output = new Uint8Array(compressed);
			if (output.length !== entry.uncompressedSize) throw officeError("ZIP_DECOMPRESSION_FAILED");
			if (crc32(output) !== entry.crc32) throw officeError("ZIP_CRC_MISMATCH");
			return output;
		}

		const chunks: Uint8Array[] = [];
		let outputSize = 0;
		const hardLimit = Math.min(maxSingleUncompressedBytes, entry.uncompressedSize);
		const inflater = new Inflate((chunk) => {
			if (chunk.length > hardLimit - outputSize) throw officeError("ZIP_DECOMPRESSION_FAILED");
			outputSize += chunk.length;
			chunks.push(new Uint8Array(chunk));
		});
		const chunkSize = 32 * 1024;
		if (compressed.length === 0) {
			inflater.push(compressed, true);
		} else {
			for (let offset = 0; offset < compressed.length; offset += chunkSize) {
				const end = Math.min(offset + chunkSize, compressed.length);
				inflater.push(compressed.subarray(offset, end), end === compressed.length);
			}
		}
		if (outputSize !== entry.uncompressedSize) throw officeError("ZIP_DECOMPRESSION_FAILED");
		const output = new Uint8Array(outputSize);
		let outputOffset = 0;
		for (const chunk of chunks) {
			output.set(chunk, outputOffset);
			outputOffset += chunk.length;
		}
		if (crc32(output) !== entry.crc32) throw officeError("ZIP_CRC_MISMATCH");
		return output;
	} catch (error) {
		if (error instanceof OfficeEngineError) throw error;
		throw officeError("ZIP_DECOMPRESSION_FAILED");
	}
}

function parseArchive(bytes: Uint8Array, limits: ArchiveLimits): ParsedArchive {
	const eocd = findEndOfCentralDirectory(bytes);
	const disk = readU16(bytes, eocd + 4);
	const centralDisk = readU16(bytes, eocd + 6);
	const entriesOnDisk = readU16(bytes, eocd + 8);
	const entryCount = readU16(bytes, eocd + 10);
	const centralSize = readU32(bytes, eocd + 12);
	const centralOffset = readU32(bytes, eocd + 16);
	if (disk !== 0 || centralDisk !== 0) throw officeError("ZIP_MULTI_DISK");
	if (
		entriesOnDisk === 0xffff ||
		entryCount === 0xffff ||
		centralSize === 0xffffffff ||
		centralOffset === 0xffffffff
	) {
		throw officeError("ZIP64_UNSUPPORTED");
	}
	if (entriesOnDisk !== entryCount) throw officeError("ZIP_MULTI_DISK");
	if (entryCount > limits.maxEntries) throw officeError("ARCHIVE_ENTRY_LIMIT");
	if (!hasRange(bytes, centralOffset, centralSize, eocd)) throw officeError("ZIP_CENTRAL_DIRECTORY_INVALID");
	if (centralOffset + centralSize !== eocd) throw officeError("ZIP_CENTRAL_DIRECTORY_TRAILING_DATA");

	const entries: InternalEntry[] = [];
	const seen = new Set<string>();
	let cursor = centralOffset;
	let totalUncompressed = 0;
	for (let index = 0; index < entryCount; index += 1) {
		if (!hasRange(bytes, cursor, 46, centralOffset + centralSize)) throw officeError("ZIP_CENTRAL_DIRECTORY_INVALID");
		if (readU32(bytes, cursor) !== CENTRAL_SIGNATURE) throw officeError("ZIP_CENTRAL_DIRECTORY_INVALID");
		const versionNeeded = readU16(bytes, cursor + 6);
		const flags = readU16(bytes, cursor + 8);
		const method = readU16(bytes, cursor + 10);
		const crc = readU32(bytes, cursor + 16);
		const compressedSize = readU32(bytes, cursor + 20);
		const uncompressedSize = readU32(bytes, cursor + 24);
		const nameLength = readU16(bytes, cursor + 28);
		const extraLength = readU16(bytes, cursor + 30);
		const commentLength = readU16(bytes, cursor + 32);
		const diskNumberStart = readU16(bytes, cursor + 34);
		const localHeaderOffset = readU32(bytes, cursor + 42);
		const recordLength = 46 + nameLength + extraLength + commentLength;
		if (!hasRange(bytes, cursor, recordLength, centralOffset + centralSize)) {
			throw officeError("ZIP_CENTRAL_DIRECTORY_INVALID");
		}
		if (diskNumberStart !== 0) throw officeError("ZIP_MULTI_DISK");
		if ((flags & 1) !== 0) throw officeError("ZIP_ENCRYPTED");
		if ((flags & 8) !== 0) throw officeError("ZIP_DATA_DESCRIPTOR");
		if (method !== STORED_METHOD && method !== DEFLATE_METHOD) throw officeError("ZIP_UNSUPPORTED_COMPRESSION");
		validateFlags(flags, method);
		const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
		validateFilenameEncoding(nameBytes, flags);
		const name = decodeName(nameBytes);
		const path = normalizePathWithLimit(name, limits.maxPathBytes);
		const key = pathKey(path);
		if (seen.has(key)) throw officeError("ARCHIVE_DUPLICATE_PATH");
		seen.add(key);
		parseExtraFields(bytes.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength));
		if (uncompressedSize > limits.maxSingleUncompressedBytes) throw officeError("ARCHIVE_SINGLE_SIZE_LIMIT");
		totalUncompressed += uncompressedSize;
		if (totalUncompressed > limits.maxTotalUncompressedBytes) throw officeError("ARCHIVE_TOTAL_SIZE_LIMIT");
		if (uncompressedSize > 0 && uncompressedSize / Math.max(compressedSize, 1) > limits.maxCompressionRatio) {
			throw officeError("ARCHIVE_COMPRESSION_RATIO_LIMIT");
		}
		if (!hasRange(bytes, localHeaderOffset, 30, centralOffset)) throw officeError("ZIP_ENTRY_RANGE_INVALID");
		if (readU32(bytes, localHeaderOffset) !== LOCAL_SIGNATURE) throw officeError("ZIP_LOCAL_HEADER_INVALID");
		const localVersionNeeded = readU16(bytes, localHeaderOffset + 4);
		const localFlags = readU16(bytes, localHeaderOffset + 6);
		const localMethod = readU16(bytes, localHeaderOffset + 8);
		const localCrc = readU32(bytes, localHeaderOffset + 14);
		const localCompressedSize = readU32(bytes, localHeaderOffset + 18);
		const localUncompressedSize = readU32(bytes, localHeaderOffset + 22);
		const localNameLength = readU16(bytes, localHeaderOffset + 26);
		const localExtraLength = readU16(bytes, localHeaderOffset + 28);
		const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
		if (!hasRange(bytes, localHeaderOffset, 30 + localNameLength + localExtraLength, centralOffset)) {
			throw officeError("ZIP_ENTRY_RANGE_INVALID");
		}
		validateVersion(localVersionNeeded, versionNeeded, method);
		if ((localFlags & 1) !== 0) throw officeError("ZIP_ENCRYPTED");
		if ((localFlags & 8) !== 0) throw officeError("ZIP_DATA_DESCRIPTOR");
		validateFlags(localFlags, localMethod);
		const localNameBytes = bytes.subarray(localHeaderOffset + 30, localHeaderOffset + 30 + localNameLength);
		validateFilenameEncoding(localNameBytes, localFlags);
		decodeName(localNameBytes);
		parseExtraFields(bytes.subarray(localHeaderOffset + 30 + localNameLength, dataOffset));
		if (
			!bytesEqual(nameBytes, localNameBytes) ||
			flags !== localFlags ||
			method !== localMethod ||
			crc !== localCrc ||
			compressedSize !== localCompressedSize ||
			uncompressedSize !== localUncompressedSize
		) {
			throw officeError("ZIP_LOCAL_CENTRAL_MISMATCH");
		}
		if (!hasRange(bytes, dataOffset, compressedSize, centralOffset)) throw officeError("ZIP_ENTRY_RANGE_INVALID");
		entries.push({
			path,
			compressedSize,
			uncompressedSize,
			compressionMethod: method,
			crc32: crc,
			centralHeaderOffset: cursor,
			centralRecordLength: recordLength,
			flags,
			localHeaderOffset,
			dataOffset,
		});
		cursor += recordLength;
	}
	if (cursor !== centralOffset + centralSize) throw officeError("ZIP_CENTRAL_DIRECTORY_INVALID");

	const ranges = entries
		.map((entry) => ({ start: entry.localHeaderOffset, end: entry.dataOffset + entry.compressedSize }))
		.sort((left, right) => left.start - right.start);
	for (let index = 1; index < ranges.length; index += 1) {
		if (ranges[index].start < ranges[index - 1].end) throw officeError("ZIP_ENTRY_OVERLAP");
	}
	return { centralOffset, centralSize, eocdOffset: eocd, entries };
}

function replaceEntryBytes(
	bytes: Uint8Array,
	parsed: ParsedArchive,
	target: InternalEntry,
	content: Uint8Array,
	maxArchiveBytes: number,
): Uint8Array {
	const compressionLevel =
		(target.flags & DEFLATE_OPTION_FLAGS) === 2 ? 9 : (target.flags & DEFLATE_OPTION_FLAGS) === 0 ? 6 : 1;
	const replacementData =
		target.compressionMethod === STORED_METHOD
			? new Uint8Array(content)
			: deflateSync(content, { level: compressionLevel });
	const replacementCrc = crc32(content);
	const originalRecordEnd = target.dataOffset + target.compressedSize;
	const replacementRecordSize = target.dataOffset - target.localHeaderOffset + replacementData.length;
	const localSize = parsed.centralOffset - (originalRecordEnd - target.localHeaderOffset) + replacementRecordSize;
	const outputSize = localSize + parsed.centralSize + (bytes.length - parsed.eocdOffset);
	if (outputSize > maxArchiveBytes) throw officeError("ARCHIVE_TOO_LARGE");
	const output = new Uint8Array(outputSize);

	let outputOffset = 0;
	let inputOffset = 0;
	const rewrittenOffsets = new Map<string, number>();
	const entriesByLocalOffset = [...parsed.entries].sort(
		(left, right) => left.localHeaderOffset - right.localHeaderOffset,
	);
	for (const entry of entriesByLocalOffset) {
		output.set(bytes.subarray(inputOffset, entry.localHeaderOffset), outputOffset);
		outputOffset += entry.localHeaderOffset - inputOffset;
		rewrittenOffsets.set(entry.path, outputOffset);
		const entryEnd = entry.dataOffset + entry.compressedSize;
		if (entry !== target) {
			output.set(bytes.subarray(entry.localHeaderOffset, entryEnd), outputOffset);
			outputOffset += entryEnd - entry.localHeaderOffset;
		} else {
			const headerLength = target.dataOffset - target.localHeaderOffset;
			output.set(bytes.subarray(target.localHeaderOffset, target.dataOffset), outputOffset);
			writeU32(output, outputOffset + 14, replacementCrc);
			writeU32(output, outputOffset + 18, replacementData.length);
			writeU32(output, outputOffset + 22, content.length);
			output.set(replacementData, outputOffset + headerLength);
			outputOffset += headerLength + replacementData.length;
		}
		inputOffset = entryEnd;
	}
	output.set(bytes.subarray(inputOffset, parsed.centralOffset), outputOffset);
	outputOffset += parsed.centralOffset - inputOffset;
	const rewrittenCentralOffset = outputOffset;

	for (const entry of parsed.entries) {
		const centralRecord = new Uint8Array(
			bytes.subarray(entry.centralHeaderOffset, entry.centralHeaderOffset + entry.centralRecordLength),
		);
		const localOffset = rewrittenOffsets.get(entry.path);
		if (localOffset === undefined) throw officeError("ARCHIVE_INVALID");
		writeU32(centralRecord, 42, localOffset);
		if (entry === target) {
			writeU32(centralRecord, 16, replacementCrc);
			writeU32(centralRecord, 20, replacementData.length);
			writeU32(centralRecord, 24, content.length);
		}
		output.set(centralRecord, outputOffset);
		outputOffset += centralRecord.length;
	}

	output.set(bytes.subarray(parsed.eocdOffset), outputOffset);
	writeU32(output, outputOffset + 12, parsed.centralSize);
	writeU32(output, outputOffset + 16, rewrittenCentralOffset);
	return output;
}

export class PackageArchive {
	private readonly bytes: Uint8Array;
	private readonly archiveEntries: ReadonlyArray<InternalEntry>;
	private readonly byPath: ReadonlyMap<string, InternalEntry>;
	private readonly limits: ArchiveLimits;
	private readonly parsed: ParsedArchive;

	constructor(input: Uint8Array, limits?: Partial<ArchiveLimits>) {
		const selectedLimits = validateLimits(limits);
		if (input.byteLength > selectedLimits.maxArchiveBytes) throw officeError("ARCHIVE_TOO_LARGE");
		this.bytes = new Uint8Array(input);
		this.parsed = parseArchive(this.bytes, selectedLimits);
		this.archiveEntries = this.parsed.entries;
		this.limits = selectedLimits;
		for (const entry of this.archiveEntries)
			decompressEntry(this.bytes, entry, selectedLimits.maxSingleUncompressedBytes);
		const pathMap = new Map<string, InternalEntry>();
		for (const entry of this.archiveEntries) pathMap.set(entry.path, entry);
		this.byPath = pathMap;
	}

	static open(input: Uint8Array, limits?: Partial<ArchiveLimits>): PackageArchive {
		return new PackageArchive(input, limits);
	}

	static from(input: Uint8Array, limits?: Partial<ArchiveLimits>): PackageArchive {
		return new PackageArchive(input, limits);
	}

	entries(): ReadonlyArray<PackageArchiveEntry> {
		return this.archiveEntries.map(({ path, compressedSize, uncompressedSize, compressionMethod, crc32 }) => ({
			path,
			compressedSize,
			uncompressedSize,
			compressionMethod,
			crc32,
		}));
	}

	read(path: string): Uint8Array {
		const normalized = normalizeOpcPath(path);
		const entry = this.byPath.get(normalized);
		if (entry === undefined) throw officeError("ARCHIVE_INVALID");
		return decompressEntry(this.bytes, entry, this.limits.maxSingleUncompressedBytes);
	}

	[REWRITE_ENTRY](path: string, content: Uint8Array): PackageArchive {
		const normalized = normalizeOpcPath(path);
		const entry = this.byPath.get(normalized);
		if (entry === undefined) throw officeError("ARCHIVE_INVALID");
		if (bytesEqual(this.read(normalized), content)) return new PackageArchive(this.bytes, this.limits);
		if (content.byteLength > this.limits.maxSingleUncompressedBytes) throw officeError("ARCHIVE_SINGLE_SIZE_LIMIT");
		const totalUncompressed = this.archiveEntries.reduce((total, item) => total + item.uncompressedSize, 0);
		if (totalUncompressed - entry.uncompressedSize + content.byteLength > this.limits.maxTotalUncompressedBytes) {
			throw officeError("ARCHIVE_TOTAL_SIZE_LIMIT");
		}
		return new PackageArchive(
			replaceEntryBytes(this.bytes, this.parsed, entry, content, this.limits.maxArchiveBytes),
			this.limits,
		);
	}

	serialize(): Uint8Array {
		return new Uint8Array(this.bytes);
	}

	save(): Uint8Array {
		return this.serialize();
	}
}

export function rewritePackageEntry(archive: PackageArchive, path: string, content: Uint8Array): PackageArchive {
	return archive[REWRITE_ENTRY](path, content);
}
