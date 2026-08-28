import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { type DocxBlockedReason, PackageArchive, sha256Hex } from "../src/index.ts";

const HEX = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(docx|xlsx|txt)$/;
const URL = /^https:\/\/raw\.githubusercontent\.com\//;
const REPOSITORY = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const XML = new XMLParser({ ignoreAttributes: false, removeNSPrefix: false, parseTagValue: false });
const WARNING_CODES = new Set([
	"UNSUPPORTED_COMMENTS",
	"UNSUPPORTED_FOOTNOTE",
	"UNSUPPORTED_ENDNOTE",
	"BLOCKED_CONTENT",
]);
const BLOCKED_REASONS = new Set<DocxBlockedReason>([
	"bookmark-boundary",
	"comment-boundary",
	"note-reference",
	"field-boundary",
	"tracked-revision",
	"content-control",
	"hyperlink-boundary",
	"drawing-content",
	"textbox-content",
	"foreign-namespace",
	"invalid-run-property",
	"complex-run",
	"xml-cdata",
	"xml-comment",
	"unsupported-paragraph-boundary",
]);
const keys = (value: object, expected: readonly string[]): void => {
	const actual = Object.keys(value).sort(),
		allowed = [...expected].sort();
	if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index]))
		throw new Error("manifest unknown or missing key");
};
const record = (value: unknown): Record<string, unknown> => {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("manifest object expected");
	return value as Record<string, unknown>;
};
const string = (value: unknown): string => {
	if (typeof value !== "string" || value.length === 0) throw new Error("manifest string expected");
	return value;
};
const safeFile = (value: unknown): string => {
	const file = string(value);
	if (!NAME.test(file) || file.includes("..") || file.includes("/") || file.includes("\\"))
		throw new Error("manifest path invalid");
	return file;
};

export interface CorpusWarning {
	readonly code: string;
	readonly part: string;
}
export interface CorpusLicense {
	readonly file: string;
	readonly sha256: string;
	readonly spdx: string;
	readonly attribution: string;
	readonly kind: "license" | "notice";
}
export interface CorpusEntry {
	readonly filename: string;
	readonly sha256: string;
	readonly source: {
		readonly repository: string;
		readonly revision: string;
		readonly version: string;
		readonly fixturePath: string;
		readonly url: string;
	};
	readonly license: { readonly id: string; readonly spdx: string; readonly attribution: string };
	readonly legalFiles: readonly string[];
	readonly producer: { readonly name: string; readonly version: string; readonly application: string };
	readonly format: {
		readonly extension: ".docx";
		readonly mainPart: string;
		readonly namespace: "transitional" | "strict";
	};
	readonly features: readonly string[];
	readonly audit: { readonly privacy: string; readonly rationale: string };
	readonly expected: {
		readonly inspect: "opens";
		readonly editableRun?: { readonly paragraphId: string; readonly runId: string; readonly text: string };
		readonly editableRelatedRun?: {
			readonly part: "header" | "footer";
			readonly relatedPartId: string;
			readonly paragraphId: string;
			readonly runId: string;
			readonly text: string;
		};
		readonly warnings: readonly CorpusWarning[];
		readonly operation: "editable" | "blocked";
		readonly blockedReason?: DocxBlockedReason;
	};
}
export interface CorpusManifest {
	readonly schemaVersion: 2;
	readonly licenses: readonly CorpusLicense[];
	readonly fixtures: readonly CorpusEntry[];
}

export function validateCorpusManifest(input: unknown): CorpusManifest {
	const root = record(input);
	keys(root, ["schemaVersion", "licenses", "fixtures"]);
	if (
		root.schemaVersion !== 2 ||
		!Array.isArray(root.licenses) ||
		root.licenses.length === 0 ||
		!Array.isArray(root.fixtures) ||
		root.fixtures.length === 0
	)
		throw new Error("manifest schema invalid");
	const licenseIds = new Set<string>();
	const licenses = root.licenses.map((raw): CorpusLicense => {
		const item = record(raw);
		keys(item, ["file", "sha256", "spdx", "attribution", "kind"]);
		const file = safeFile(item.file),
			id = file;
		if (licenseIds.has(id) || !HEX.test(string(item.sha256))) throw new Error("license invalid or duplicate");
		licenseIds.add(id);
		if (item.kind !== "license" && item.kind !== "notice") throw new Error("legal artifact kind invalid");
		return {
			file,
			sha256: string(item.sha256),
			spdx: string(item.spdx),
			attribution: string(item.attribution),
			kind: item.kind,
		};
	});
	const seen = new Set<string>();
	const fixtures = root.fixtures.map((raw): CorpusEntry => {
		const item = record(raw);
		keys(item, [
			"filename",
			"sha256",
			"source",
			"license",
			"legalFiles",
			"producer",
			"format",
			"features",
			"audit",
			"expected",
		]);
		const filename = safeFile(item.filename);
		if (!filename.endsWith(".docx") || seen.has(filename) || !HEX.test(string(item.sha256)))
			throw new Error("fixture invalid or duplicate");
		seen.add(filename);
		const source = record(item.source);
		keys(source, ["repository", "revision", "version", "fixturePath", "url"]);
		if (
			!REPOSITORY.test(string(source.repository)) ||
			!URL.test(string(source.url)) ||
			!/^[A-Za-z0-9._-]+$/.test(string(source.revision)) ||
			!/^[A-Za-z0-9._/-]+\.docx$/.test(string(source.fixturePath)) ||
			string(source.fixturePath).startsWith("/") ||
			string(source.fixturePath)
				.split("/")
				.some((segment) => segment === "" || segment === "." || segment === "..") ||
			string(source.url) !==
				`${string(source.repository).replace("https://github.com/", "https://raw.githubusercontent.com/")}/${source.revision}/${string(source.fixturePath)}`
		)
			throw new Error("source invalid");
		const license = record(item.license);
		keys(license, ["id", "spdx", "attribution"]);
		const legalFiles = item.legalFiles;
		if (!Array.isArray(legalFiles) || legalFiles.length === 0 || legalFiles.some((file) => !licenseIds.has(file)))
			throw new Error("legal files invalid");
		const licenseId = string(license.id);
		if (!licenseIds.has(licenseId)) throw new Error("license reference invalid");
		const producer = record(item.producer);
		keys(producer, ["name", "version", "application"]);
		const format = record(item.format);
		keys(format, ["extension", "mainPart", "namespace"]);
		if (format.extension !== ".docx" || (format.namespace !== "strict" && format.namespace !== "transitional"))
			throw new Error("format invalid");
		const audit = record(item.audit);
		keys(audit, ["privacy", "rationale"]);
		string(audit.privacy);
		string(audit.rationale);
		const expected = record(item.expected);
		const expectedKeys = ["inspect", "warnings", "operation"];
		if (expected.editableRun !== undefined) expectedKeys.push("editableRun");
		if (expected.editableRelatedRun !== undefined) expectedKeys.push("editableRelatedRun");
		if (expected.blockedReason !== undefined) expectedKeys.push("blockedReason");
		keys(expected, expectedKeys);
		if (
			expected.inspect !== "opens" ||
			(expected.operation !== "editable" && expected.operation !== "blocked") ||
			(expected.operation === "blocked" && !BLOCKED_REASONS.has(expected.blockedReason as DocxBlockedReason)) ||
			(expected.operation === "editable" && expected.blockedReason !== undefined)
		)
			throw new Error("expectation invalid");
		if (
			!Array.isArray(item.features) ||
			item.features.some((feature) => typeof feature !== "string" || feature.length === 0) ||
			!Array.isArray(expected.warnings)
		)
			throw new Error("features or warnings invalid");
		for (const warningRaw of expected.warnings) {
			const warning = record(warningRaw);
			keys(warning, ["code", "part"]);
			if (!WARNING_CODES.has(string(warning.code)) || !string(warning.part).endsWith(".xml"))
				throw new Error("warning invalid");
		}
		if (expected.editableRun !== undefined && expected.editableRelatedRun !== undefined) {
			throw new Error("expectation has multiple editable targets");
		}
		if (expected.editableRun !== undefined) {
			const run = record(expected.editableRun);
			keys(run, ["paragraphId", "runId", "text"]);
			string(run.paragraphId);
			string(run.runId);
			if (typeof run.text !== "string") throw new Error("run invalid");
		}
		if (expected.editableRelatedRun !== undefined) {
			const run = record(expected.editableRelatedRun);
			keys(run, ["part", "relatedPartId", "paragraphId", "runId", "text"]);
			if (run.part !== "header" && run.part !== "footer") throw new Error("related run part invalid");
			string(run.relatedPartId);
			string(run.paragraphId);
			string(run.runId);
			if (typeof run.text !== "string") throw new Error("related run invalid");
		}
		return {
			filename,
			sha256: string(item.sha256),
			source: {
				repository: string(source.repository),
				revision: string(source.revision),
				version: string(source.version),
				fixturePath: string(source.fixturePath),
				url: string(source.url),
			},
			license: { id: licenseId, spdx: string(license.spdx), attribution: string(license.attribution) },
			legalFiles: legalFiles as string[],
			producer: {
				name: string(producer.name),
				version: string(producer.version),
				application: string(producer.application),
			},
			format: {
				extension: ".docx",
				mainPart: string(format.mainPart),
				namespace: format.namespace as "strict" | "transitional",
			},
			features: item.features as string[],
			audit: { privacy: string(audit.privacy), rationale: string(audit.rationale) },
			expected: expected as CorpusEntry["expected"],
		};
	});
	const referenced = new Set(fixtures.flatMap((entry) => entry.legalFiles));
	for (const license of licenses) if (!referenced.has(license.file)) throw new Error("unreferenced legal artifact");
	for (const entry of fixtures) {
		if (!entry.legalFiles.includes(entry.license.id)) throw new Error("primary license not referenced");
		for (const file of entry.legalFiles) {
			const artifact = licenses.find((license) => license.file === file);
			if (!artifact) throw new Error("legal artifact missing");
		}
	}
	return { schemaVersion: 2, licenses, fixtures };
}
export function loadCorpus(): { readonly root: string; readonly manifest: CorpusManifest } {
	const root = resolve(import.meta.dirname, "../test/corpus");
	return { root, manifest: validateCorpusManifest(JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"))) };
}
export function validateCorpusDirectory(root: string, manifest: CorpusManifest): void {
	const actual = readdirSync(root)
		.filter((name) => name !== "manifest.json")
		.sort();
	const listed = [
		...manifest.fixtures.map((entry) => entry.filename),
		...manifest.licenses.map((license) => license.file),
	].sort();
	if (actual.length !== listed.length || actual.some((name, index) => name !== listed[index]))
		throw new Error("corpus directory/manifest mismatch");
}
export function assertCorpusAdmission(): { readonly root: string; readonly manifest: CorpusManifest } {
	const loaded = loadCorpus();
	validateCorpusDirectory(loaded.root, loaded.manifest);
	for (const license of loaded.manifest.licenses) {
		const bytes = new Uint8Array(readFileSync(resolve(loaded.root, license.file)));
		if (
			sha256Hex(bytes) !== license.sha256 ||
			!readFileSync(resolve(loaded.root, license.file), "utf8").includes(license.attribution)
		)
			throw new Error("license admission failed");
	}
	for (const entry of loaded.manifest.fixtures) {
		const bytes = new Uint8Array(readFileSync(resolve(loaded.root, entry.filename)));
		if (sha256Hex(bytes) !== entry.sha256) throw new Error("fixture hash mismatch");
		const archive = PackageArchive.open(bytes);
		const app = XML.parse(new TextDecoder("utf-8", { fatal: true }).decode(archive.read("docProps/app.xml")));

		const properties = app.Properties as Record<string, unknown> | undefined;
		const expectedPropertiesNamespace =
			entry.format.namespace === "strict"
				? "http://purl.oclc.org/ooxml/officeDocument/extendedProperties"
				: "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties";
		if (
			!properties ||
			properties["@_xmlns"] !== expectedPropertiesNamespace ||
			typeof properties.Application !== "string" ||
			properties.Application !== entry.producer.application
		)
			throw new Error("producer metadata mismatch");
		const license = loaded.manifest.licenses.find((item) => item.file === entry.license.id);
		if (!license || license.spdx !== entry.license.spdx || license.attribution !== entry.license.attribution)
			throw new Error("fixture license mismatch");
	}
	return loaded;
}

export interface XlsxCorpusEntry {
	readonly filename: string;
	readonly sha256: string;
	readonly source: {
		readonly repository: string;
		readonly revision: string;
		readonly fixturePath: string;
		readonly url: string;
	};
	readonly license: { readonly id: string; readonly spdx: string; readonly attribution: string };
	readonly legalFiles: readonly string[];
	readonly producer: { readonly name: string; readonly version: string; readonly application: string };
	readonly format: { readonly extension: ".xlsx"; readonly workbookPart: string };
	readonly features: readonly string[];
	readonly audit: { readonly privacy: string; readonly rationale: string };
	readonly expected: { readonly sheetId: string; readonly cellId: string; readonly address: string; readonly value: string };
}
export interface XlsxCorpusManifest {
	readonly schemaVersion: 2;
	readonly legalArtifacts: readonly CorpusLicense[];
	readonly fixtures: readonly XlsxCorpusEntry[];
}

export function validateXlsxCorpusManifest(input: unknown): XlsxCorpusManifest {
	const root = record(input);
	keys(root, ["schemaVersion", "legalArtifacts", "fixtures"]);
	if (root.schemaVersion !== 2 || !Array.isArray(root.legalArtifacts) || !Array.isArray(root.fixtures))
		throw new Error("XLSX manifest schema invalid");
	const legalIds = new Set<string>();
	const legalArtifacts = root.legalArtifacts.map((raw): CorpusLicense => {
		const item = record(raw);
		keys(item, ["file", "sha256", "spdx", "attribution", "kind"]);
		const file = safeFile(item.file);
		if (
			!file.endsWith(".txt") ||
			legalIds.has(file) ||
			!HEX.test(string(item.sha256)) ||
			(item.kind !== "license" && item.kind !== "notice")
		)
			throw new Error("XLSX legal artifact invalid");
		legalIds.add(file);
		return {
			file,
			sha256: string(item.sha256),
			spdx: string(item.spdx),
			attribution: string(item.attribution),
			kind: item.kind,
		};
	});
	if (legalArtifacts.length === 0 || root.fixtures.length === 0) throw new Error("XLSX manifest empty");
	const filenames = new Set<string>();
	const fixtures = root.fixtures.map((raw): XlsxCorpusEntry => {
		const item = record(raw);
		keys(item, ["filename", "sha256", "source", "license", "legalFiles", "producer", "format", "features", "audit", "expected"]);
		const filename = safeFile(item.filename);
		if (!filename.endsWith(".xlsx") || filenames.has(filename) || !HEX.test(string(item.sha256)))
			throw new Error("XLSX fixture invalid");
		filenames.add(filename);
		const source = record(item.source);
		keys(source, ["repository", "revision", "fixturePath", "url"]);
		const repository = string(source.repository), revision = string(source.revision), fixturePath = string(source.fixturePath);
		if (
			!REPOSITORY.test(repository) ||
			!/^[0-9a-f]{40}$/u.test(revision) ||
			!/^[-A-Za-z0-9._/]+\.xlsx$/u.test(fixturePath) ||
			fixturePath.startsWith("/") ||
			fixturePath.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
			string(source.url) !== `${repository.replace("https://github.com/", "https://raw.githubusercontent.com/")}/${revision}/${fixturePath}`
		)
			throw new Error("XLSX source invalid");
		const license = record(item.license);
		keys(license, ["id", "spdx", "attribution"]);
		const licenseId = string(license.id);
		if (!legalIds.has(licenseId)) throw new Error("XLSX license invalid");
		if (!Array.isArray(item.legalFiles) || item.legalFiles.length === 0 || item.legalFiles.some((file) => typeof file !== "string" || !legalIds.has(file)))
			throw new Error("XLSX legal files invalid");
		const producer = record(item.producer);
		keys(producer, ["name", "version", "application"]);
		const format = record(item.format);
		keys(format, ["extension", "workbookPart"]);
		if (format.extension !== ".xlsx" || string(format.workbookPart) !== "xl/workbook.xml")
			throw new Error("XLSX format invalid");
		const audit = record(item.audit);
		keys(audit, ["privacy", "rationale"]);
		const expected = record(item.expected);
		keys(expected, ["sheetId", "cellId", "address", "value"]);
		if (typeof expected.value !== "string") throw new Error("XLSX expected value invalid");
		if (!Array.isArray(item.features) || item.features.some((feature) => typeof feature !== "string" || !feature))
			throw new Error("XLSX features invalid");
		return {
			filename,
			sha256: string(item.sha256),
			source: { repository, revision, fixturePath, url: string(source.url) },
			license: { id: licenseId, spdx: string(license.spdx), attribution: string(license.attribution) },
			legalFiles: item.legalFiles as string[],
			producer: { name: string(producer.name), version: string(producer.version), application: string(producer.application) },
			format: { extension: ".xlsx", workbookPart: "xl/workbook.xml" },
			features: item.features as string[],
			audit: { privacy: string(audit.privacy), rationale: string(audit.rationale) },
			expected: { sheetId: string(expected.sheetId), cellId: string(expected.cellId), address: string(expected.address), value: expected.value },
		};
	});
	const referenced = new Set(fixtures.flatMap((entry) => entry.legalFiles));
	if (legalArtifacts.some((artifact) => !referenced.has(artifact.file))) throw new Error("XLSX legal artifact unreferenced");
	for (const entry of fixtures) {
		if (!entry.legalFiles.includes(entry.license.id)) throw new Error("XLSX primary license missing");
		const primary = legalArtifacts.find((artifact) => artifact.file === entry.license.id);
		if (!primary || primary.spdx !== entry.license.spdx || primary.attribution !== entry.license.attribution)
			throw new Error("XLSX fixture license mismatch");
	}
	return { schemaVersion: 2, legalArtifacts, fixtures };
}

export function assertXlsxCorpusAdmission(): { readonly root: string; readonly manifest: XlsxCorpusManifest } {
	const root = resolve(import.meta.dirname, "../test/corpus-xlsx");
	const manifest = validateXlsxCorpusManifest(JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8")));
	const actual = readdirSync(root).filter((name) => name !== "manifest.json").sort();
	const listed = [...manifest.legalArtifacts.map((item) => item.file), ...manifest.fixtures.map((item) => item.filename)].sort();
	if (actual.length !== listed.length || actual.some((name, index) => name !== listed[index]))
		throw new Error("XLSX corpus directory/manifest mismatch");
	for (const artifact of manifest.legalArtifacts) {
		const bytes = new Uint8Array(readFileSync(resolve(root, artifact.file)));
		if (sha256Hex(bytes) !== artifact.sha256 || !new TextDecoder().decode(bytes).includes(artifact.attribution))
			throw new Error("XLSX legal admission failed");
	}
	for (const entry of manifest.fixtures) {
		const bytes = new Uint8Array(readFileSync(resolve(root, entry.filename)));
		if (sha256Hex(bytes) !== entry.sha256) throw new Error("XLSX fixture hash mismatch");
		const archive = PackageArchive.open(bytes);
		const app = XML.parse(new TextDecoder("utf-8", { fatal: true }).decode(archive.read("docProps/app.xml")));
		const properties = app.Properties as Record<string, unknown> | undefined;
		if (!properties || properties.Application !== entry.producer.application || properties.AppVersion !== entry.producer.version)
			throw new Error("XLSX producer metadata mismatch");
	}
	return { root, manifest };
}
