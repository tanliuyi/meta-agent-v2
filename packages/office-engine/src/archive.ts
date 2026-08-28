import { sha256 } from "@noble/hashes/sha2.js";
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
	readonly localHeaderOffset: number;
	readonly dataOffset: number;
	readonly centralOffset: number;
	readonly centralRecordLength: number;
	readonly localRecordLength: number;
	readonly descriptorOffset: number;
	readonly descriptorLength: 0 | 12 | 16;
	readonly descriptorSigned: boolean;
	readonly eocdOffset: number;
};
type ArchiveLayoutSegment = {
	readonly start: number;
	readonly end: number;
};

type ParsedArchive = {
	readonly entries: InternalEntry[];
	readonly opaqueSegments: readonly ArchiveLayoutSegment[];
	readonly centralStart: number;
};

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

function readU16(bytes: Uint8Array, offset: number): number {
	return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
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

export function resolveOpcRelationshipTarget(target: string, sourcePart?: string): string {
	if (typeof target !== "string" || target.length === 0 || target.includes("\\") || target.includes("\u0000"))
		throw officeError("ARCHIVE_UNSAFE_PATH");
	for (const match of target.matchAll(/%([0-9a-f]{2})/giu)) {
		const codePoint = Number.parseInt(match[1]!, 16);
		if ([0x00, 0x23, 0x2e, 0x2f, 0x3f, 0x5c].includes(codePoint)) throw officeError("ARCHIVE_UNSAFE_PATH");
	}
	let decoded: string;
	try {
		decoded = decodeURIComponent(target);
	} catch {
		throw officeError("ARCHIVE_UNSAFE_PATH");
	}
	if (
		decoded.length === 0 ||
		decoded.startsWith("//") ||
		decoded.includes("\\") ||
		decoded.includes("\u0000") ||
		decoded.includes("?") ||
		decoded.includes("#") ||
		/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(decoded) ||
		/[\u2044\u2215\u2216\u2217\u29f8\uff0f\uff3c\u2024\u2025]/u.test(decoded)
	)
		throw officeError("ARCHIVE_UNSAFE_PATH");
	if (sourcePart === undefined && decoded.startsWith("/")) decoded = decoded.slice(1);
	else if (sourcePart !== undefined && decoded.startsWith("/")) throw officeError("ARCHIVE_UNSAFE_PATH");
	const decodedSegments = decoded.split("/");
	if (
		decodedSegments.some((segment) => segment.length === 0 || segment === ".") ||
		(sourcePart === undefined && decodedSegments.includes(".."))
	)
		throw officeError("ARCHIVE_UNSAFE_PATH");
	const base =
		sourcePart === undefined
			? []
			: sourcePart
					.slice(0, sourcePart.lastIndexOf("/") + 1)
					.split("/")
					.filter(Boolean);
	const resolved: string[] = [];
	for (const segment of [...base, ...decodedSegments]) {
		if (segment === "..") {
			if (resolved.length === 0) throw officeError("ARCHIVE_UNSAFE_PATH");
			resolved.pop();
		} else resolved.push(segment);
	}
	if (resolved.length === 0) throw officeError("ARCHIVE_UNSAFE_PATH");
	return normalizeOpcPath(resolved.join("/"));
}

function normalizePathWithLimit(path: string, maxPathBytes: number): string {
	const normalized = normalizeOpcPath(path);
	if (UTF8_ENCODER.encode(normalized).length > maxPathBytes) throw officeError("ARCHIVE_PATH_TOO_LONG");
	return normalized;
}

function updateCrc32(crc: number, bytes: Uint8Array): number {
	let current = crc;
	for (const byte of bytes) {
		current ^= byte;
		for (let bit = 0; bit < 8; bit += 1) current = (current >>> 1) ^ (current & 1 ? 0xedb88320 : 0);
	}
	return current;
}

function crc32(bytes: Uint8Array): number {
	return (updateCrc32(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
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
	const allowed = (method === DEFLATE_METHOD ? UTF8_FLAG | DEFLATE_OPTION_FLAGS : UTF8_FLAG) | 8;
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

function decompressEntry(
	bytes: Uint8Array,
	entry: InternalEntry,
	maxSingleUncompressedBytes: number,
	collect: boolean,
): Uint8Array {
	const compressed = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
	try {
		if (entry.uncompressedSize > maxSingleUncompressedBytes) throw officeError("ARCHIVE_SINGLE_SIZE_LIMIT");
		if (entry.compressionMethod === DEFLATE_METHOD && compressed.length === 0) {
			throw officeError("ZIP_DECOMPRESSION_FAILED");
		}
		if (entry.compressionMethod === STORED_METHOD) {
			if (compressed.length !== entry.uncompressedSize) throw officeError("ZIP_DECOMPRESSION_FAILED");
			if (crc32(compressed) !== entry.crc32) throw officeError("ZIP_CRC_MISMATCH");
			return collect ? new Uint8Array(compressed) : new Uint8Array();
		}

		const chunks: Uint8Array[] = [];
		let outputSize = 0;
		let crc = 0xffffffff;
		const hardLimit = Math.min(maxSingleUncompressedBytes, entry.uncompressedSize);
		const inflater = new Inflate((chunk) => {
			if (chunk.length > hardLimit - outputSize) throw officeError("ZIP_DECOMPRESSION_FAILED");
			outputSize += chunk.length;
			crc = updateCrc32(crc, chunk);
			if (collect) chunks.push(new Uint8Array(chunk));
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
		if ((crc ^ 0xffffffff) >>> 0 !== entry.crc32) throw officeError("ZIP_CRC_MISMATCH");
		if (!collect) return new Uint8Array();
		const output = new Uint8Array(outputSize);
		let outputOffset = 0;
		for (const chunk of chunks) {
			output.set(chunk, outputOffset);
			outputOffset += chunk.length;
		}
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
		validateFlags(localFlags, localMethod);
		const localNameBytes = bytes.subarray(localHeaderOffset + 30, localHeaderOffset + 30 + localNameLength);
		validateFilenameEncoding(localNameBytes, localFlags);
		decodeName(localNameBytes);
		parseExtraFields(bytes.subarray(localHeaderOffset + 30 + localNameLength, dataOffset));
		if (
			!bytesEqual(nameBytes, localNameBytes) ||
			flags !== localFlags ||
			method !== localMethod ||
			(!((flags & 8) !== 0) &&
				(crc !== localCrc || compressedSize !== localCompressedSize || uncompressedSize !== localUncompressedSize))
		) {
			throw officeError("ZIP_LOCAL_CENTRAL_MISMATCH");
		}
		if (!hasRange(bytes, dataOffset, compressedSize, centralOffset)) throw officeError("ZIP_ENTRY_RANGE_INVALID");
		let descriptorLength: 0 | 12 | 16 = 0;
		let descriptorSigned = false;
		const descriptorOffset = dataOffset + compressedSize;
		if ((flags & 8) !== 0) {
			if (!hasRange(bytes, descriptorOffset, 12, centralOffset)) throw officeError("ZIP_ENTRY_RANGE_INVALID");
			const candidate12 = descriptorOffset;
			const candidate16 = descriptorOffset + 4;
			const valid12 =
				hasRange(bytes, candidate12, 12, centralOffset) &&
				readU32(bytes, candidate12) === crc &&
				readU32(bytes, candidate12 + 4) === compressedSize &&
				readU32(bytes, candidate12 + 8) === uncompressedSize;
			const valid16 =
				hasRange(bytes, candidate16, 12, centralOffset) &&
				readU32(bytes, descriptorOffset) === 0x08074b50 &&
				readU32(bytes, candidate16) === crc &&
				readU32(bytes, candidate16 + 4) === compressedSize &&
				readU32(bytes, candidate16 + 8) === uncompressedSize;
			if (valid12 === valid16) throw officeError("ZIP_LOCAL_CENTRAL_MISMATCH");
			descriptorLength = valid16 ? 16 : 12;
			descriptorSigned = valid16;
		}
		entries.push({
			path,
			compressedSize,
			uncompressedSize,
			compressionMethod: method,
			crc32: crc,
			localHeaderOffset,
			dataOffset,
			centralOffset: cursor,
			centralRecordLength: recordLength,
			localRecordLength: 30 + localNameLength + localExtraLength + compressedSize + descriptorLength,
			descriptorOffset,
			descriptorLength,
			descriptorSigned,
			eocdOffset: eocd,
		});
		cursor += recordLength;
	}
	if (cursor !== centralOffset + centralSize) throw officeError("ZIP_CENTRAL_DIRECTORY_INVALID");

	const ranges = entries
		.map((entry) => ({ start: entry.localHeaderOffset, end: entry.localHeaderOffset + entry.localRecordLength }))
		.sort((left, right) => left.start - right.start);
	for (let index = 1; index < ranges.length; index += 1) {
		if (ranges[index].start < ranges[index - 1].end) throw officeError("ZIP_ENTRY_OVERLAP");
	}
	const opaqueSegments: ArchiveLayoutSegment[] = [];
	let opaqueStart = 0;
	for (const range of ranges) {
		if (opaqueStart < range.start) opaqueSegments.push({ start: opaqueStart, end: range.start });
		opaqueStart = range.end;
	}
	if (opaqueStart < centralOffset) opaqueSegments.push({ start: opaqueStart, end: centralOffset });
	return { entries, opaqueSegments, centralStart: centralOffset };
}

export interface ArchiveDeltaReport {
	readonly target: string;
	readonly sourceSha256: string;
	readonly outputSha256: string;
	readonly changedEntries: readonly string[];
	readonly unchangedEntries: readonly string[];
}

function archiveHash(value: Uint8Array): string {
	return Array.from(sha256(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function verifyReplacement(
	source: Uint8Array,
	output: Uint8Array,
	path: string,
	replacement: Uint8Array,
): ArchiveDeltaReport {
	const targetPath = normalizeOpcPath(path);
	const sourceParsed = parseArchive(source, validateLimits(undefined));
	const outputParsed = parseArchive(output, validateLimits(undefined));
	const sourceEntries = sourceParsed.entries;
	const outputEntries = outputParsed.entries;
	if (sourceEntries.length !== outputEntries.length) throw officeError("ARCHIVE_INVALID");
	const sourceTarget = sourceEntries.find((entry) => entry.path === targetPath);
	const outputTarget = outputEntries.find((entry) => entry.path === targetPath);
	if (sourceTarget === undefined || outputTarget === undefined) throw officeError("ARCHIVE_INVALID");
	const localDelta = outputTarget.compressedSize - sourceTarget.compressedSize;
	const sourceCentralStart = sourceParsed.centralStart;
	const outputCentralStart = outputParsed.centralStart;
	if (outputCentralStart !== sourceCentralStart + localDelta) throw officeError("ARCHIVE_INVALID");

	const changed: string[] = [];
	const unchanged: string[] = [];
	const outputByPath = new Map(outputEntries.map((entry) => [entry.path, entry]));
	for (const left of sourceEntries) {
		const right = outputByPath.get(left.path);
		if (right === undefined) throw officeError("ARCHIVE_INVALID");
		const leftCentral = source.slice(left.centralOffset, left.centralOffset + left.centralRecordLength);
		const rightCentral = output.slice(right.centralOffset, right.centralOffset + right.centralRecordLength);
		if (left.descriptorLength !== right.descriptorLength || left.descriptorSigned !== right.descriptorSigned)
			throw officeError("ARCHIVE_INVALID");
		if (
			!bytesEqual(leftCentral.slice(0, 16), rightCentral.slice(0, 16)) ||
			!bytesEqual(leftCentral.slice(28, 42), rightCentral.slice(28, 42)) ||
			!bytesEqual(leftCentral.slice(46), rightCentral.slice(46))
		)
			throw officeError("ARCHIVE_INVALID");
		const expectedLocalOffset =
			left.localHeaderOffset > sourceTarget.localHeaderOffset
				? left.localHeaderOffset + localDelta
				: left.localHeaderOffset;
		if (right.localHeaderOffset !== expectedLocalOffset) throw officeError("ARCHIVE_INVALID");
		if (left.path === targetPath) {
			const after = new PackageArchive(output);
			if (!bytesEqual(after.read(targetPath), replacement)) throw officeError("ARCHIVE_INVALID");
			if (
				!bytesEqual(
					source.subarray(left.localHeaderOffset, left.localHeaderOffset + 14),
					output.subarray(right.localHeaderOffset, right.localHeaderOffset + 14),
				) ||
				!bytesEqual(
					source.subarray(left.localHeaderOffset + 26, left.dataOffset),
					output.subarray(right.localHeaderOffset + 26, right.dataOffset),
				)
			)
				throw officeError("ARCHIVE_INVALID");
			changed.push(targetPath);
		} else {
			const leftLocal = source.subarray(left.localHeaderOffset, left.localHeaderOffset + left.localRecordLength);
			const rightLocal = output.subarray(right.localHeaderOffset, right.localHeaderOffset + right.localRecordLength);
			if (!bytesEqual(leftLocal, rightLocal)) throw officeError("ARCHIVE_INVALID");
			unchanged.push(left.path);
		}
	}

	const sourceByLocal = [...sourceEntries].sort((left, right) => left.localHeaderOffset - right.localHeaderOffset);
	const outputByLocal = [...outputEntries].sort((left, right) => left.localHeaderOffset - right.localHeaderOffset);
	if (sourceByLocal.length !== outputByLocal.length) throw officeError("ARCHIVE_INVALID");
	for (let index = 0; index < sourceByLocal.length; index += 1) {
		if (sourceByLocal[index].path !== outputByLocal[index].path) throw officeError("ARCHIVE_INVALID");
	}
	if (sourceParsed.opaqueSegments.length !== outputParsed.opaqueSegments.length) throw officeError("ARCHIVE_INVALID");
	for (let index = 0; index < sourceParsed.opaqueSegments.length; index += 1) {
		const sourceSegment = sourceParsed.opaqueSegments[index];
		const outputSegment = outputParsed.opaqueSegments[index];
		const shift = sourceSegment.start >= sourceTarget.dataOffset + sourceTarget.compressedSize ? localDelta : 0;
		if (
			outputSegment.start !== sourceSegment.start + shift ||
			outputSegment.end - outputSegment.start !== sourceSegment.end - sourceSegment.start
		)
			throw officeError("ARCHIVE_INVALID");
		if (
			!bytesEqual(
				source.slice(sourceSegment.start, sourceSegment.end),
				output.slice(outputSegment.start, outputSegment.end),
			)
		)
			throw officeError("ARCHIVE_INVALID");
	}
	if (changed.length !== 1) throw officeError("ARCHIVE_INVALID");
	const sourceEnd = sourceEntries[0]?.eocdOffset ?? source.length - 22;
	const outputEnd = outputEntries[0]?.eocdOffset ?? output.length - 22;
	const sourceEocd = source.slice(sourceEnd, sourceEnd + 22),
		outputEocd = output.slice(outputEnd, outputEnd + 22);
	if (
		!bytesEqual(sourceEocd.slice(0, 16), outputEocd.slice(0, 16)) ||
		!bytesEqual(source.slice(sourceEnd + 20), output.slice(outputEnd + 20)) ||
		readU32(outputEocd, 16) !== sourceCentralStart + localDelta
	)
		throw officeError("ARCHIVE_INVALID");
	return Object.freeze({
		target: targetPath,
		sourceSha256: archiveHash(source),
		outputSha256: archiveHash(output),
		changedEntries: changed,
		unchangedEntries: unchanged,
	});
}

export class PackageArchive {
	private readonly bytes: Uint8Array;
	private readonly archiveEntries: ReadonlyArray<InternalEntry>;
	private readonly byPath: ReadonlyMap<string, InternalEntry>;
	private readonly maxSingleUncompressedBytes: number;
	private readonly maxArchiveBytes: number;

	constructor(input: Uint8Array, limits?: Partial<ArchiveLimits>) {
		const selectedLimits = validateLimits(limits);
		if (input.byteLength > selectedLimits.maxArchiveBytes) throw officeError("ARCHIVE_TOO_LARGE");
		this.bytes = new Uint8Array(input);
		this.archiveEntries = parseArchive(this.bytes, selectedLimits).entries;
		this.maxSingleUncompressedBytes = selectedLimits.maxSingleUncompressedBytes;
		this.maxArchiveBytes = selectedLimits.maxArchiveBytes;
		for (const entry of this.archiveEntries) {
			if (entry.path.toLowerCase().startsWith("_xmlsignatures/")) throw officeError("ARCHIVE_INVALID");
			decompressEntry(this.bytes, entry, selectedLimits.maxSingleUncompressedBytes, false);
		}
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
		return decompressEntry(this.bytes, entry, this.maxSingleUncompressedBytes, true);
	}

	serialize(): Uint8Array {
		return new Uint8Array(this.bytes);
	}

	save(): Uint8Array {
		return this.serialize();
	}

	replace(path: string, content: Uint8Array): Uint8Array {
		const normalized = normalizeOpcPath(path);
		const target = this.byPath.get(normalized);
		if (target === undefined) throw officeError("ARCHIVE_INVALID");
		if (bytesEqual(content, this.read(normalized))) return this.serialize();
		if (content.byteLength > this.maxSingleUncompressedBytes || content.byteLength > 0xffffffff)
			throw officeError("ARCHIVE_SINGLE_SIZE_LIMIT");
		if (this.bytes.length - target.compressedSize + content.byteLength > this.maxArchiveBytes)
			throw officeError("ARCHIVE_TOO_LARGE");
		const compressed = target.compressionMethod === STORED_METHOD ? new Uint8Array(content) : deflateSync(content);
		const updated = new Uint8Array(this.bytes.length + compressed.length - target.compressedSize);
		const localDelta = compressed.length - target.compressedSize;
		const centralStart =
			this.archiveEntries.length === 0
				? this.bytes.length
				: Math.min(...this.archiveEntries.map((entry) => entry.centralOffset));

		const copyRange = (sourceStart: number, sourceEnd: number, destinationStart: number): void => {
			updated.set(this.bytes.subarray(sourceStart, sourceEnd), destinationStart);
		};
		copyRange(0, target.dataOffset, 0);
		updated.set(compressed, target.dataOffset);
		copyRange(target.dataOffset + target.compressedSize, centralStart, target.dataOffset + compressed.length);
		copyRange(centralStart, this.bytes.length, centralStart + localDelta);
		const local = target.localHeaderOffset;
		const central = target.centralOffset + localDelta;
		const write32 = (offset: number, value: number): void => {
			updated[offset] = value & 255;
			updated[offset + 1] = (value >>> 8) & 255;
			updated[offset + 2] = (value >>> 16) & 255;
			updated[offset + 3] = (value >>> 24) & 255;
		};
		if ((readU16(this.bytes, local + 6) & 8) === 0) {
			write32(local + 14, crc32(content));
			write32(local + 18, compressed.length);
			write32(local + 22, content.length);
		} else {
			const descriptor = target.descriptorOffset + localDelta + (target.descriptorSigned ? 4 : 0);
			write32(descriptor, crc32(content));
			write32(descriptor + 4, compressed.length);
			write32(descriptor + 8, content.length);
		}
		write32(central + 16, crc32(content));
		write32(central + 20, compressed.length);
		write32(central + 24, content.length);
		for (const entry of this.archiveEntries) {
			const centralRecord = entry.centralOffset + localDelta;
			if (entry.localHeaderOffset > target.localHeaderOffset)
				write32(centralRecord + 42, entry.localHeaderOffset + localDelta);
		}
		const eocd = target.eocdOffset + localDelta;

		write32(eocd + 16, centralStart + localDelta);
		verifyReplacement(this.bytes, updated, normalized, content);
		return updated;
	}
}
