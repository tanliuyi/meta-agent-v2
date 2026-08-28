import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import {
	commitDocx,
	commitXlsx,
	inspectDocx,
	inspectXlsx,
	PackageArchive,
	planDocx,
	planXlsx,
} from "../src/index.ts";

interface TimedBudget {
	readonly elapsedMs: number;
	readonly rssDeltaBytes: number;
}

interface PerformanceBudget {
	readonly schemaVersion: 1;
	readonly baseline: Record<string, unknown>;
	readonly thresholds: {
		readonly archive10MiB: TimedBudget;
		readonly archive50MiB: TimedBudget;
		readonly inspect1000ParagraphsMs: number;
		readonly inspect10000ParagraphsMs: number;
		readonly planAndCommit10000ParagraphsMs: number;
		readonly inspect10000CellsMs: number;
		readonly planAndCommit10000CellsMs: number;
	};
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const budget = JSON.parse(readFileSync(resolve(scriptDirectory, "performance-budget.json"), "utf8")) as PerformanceBudget;
if (budget.schemaVersion !== 1) throw new Error("unsupported performance budget schema");

const encoder = new TextEncoder();
const contentTypes =
	'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const relationships =
	'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';

function documentPackage(documentXml: string, payloadBytes = 0): Uint8Array {
	const entries: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
		"[Content_Types].xml": encoder.encode(contentTypes),
		"_rels/.rels": encoder.encode(relationships),
		"word/document.xml": encoder.encode(documentXml),
	};
	if (payloadBytes > 0) {
		const payload = new Uint8Array(payloadBytes);
		for (let index = 0; index < payload.length; index++) payload[index] = (index * 31 + (index >>> 8) * 17 + 0x5a) & 0xff;
		entries["word/media/deterministic.bin"] = [payload, { level: 0 }];
	}
	return zipSync(entries);
}

function paragraphDocument(count: number): string {
	let body = "";
	for (let index = 0; index < count; index++) body += `<w:p><w:r><w:t>Paragraph ${index}</w:t></w:r></w:p>`;
	return `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
}

function spreadsheetPackage(cellCount: number): Uint8Array {
	let rows = "";
	for (let row = 1; row <= cellCount; row++) rows += `<row r="${row}"><c r="A${row}"><v>${row}</v></c></row>`;
	return zipSync({
		"[Content_Types].xml": encoder.encode(
			'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
		),
		"_rels/.rels": encoder.encode(
			'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="root" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
		),
		"xl/workbook.xml": encoder.encode(
			'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Performance" sheetId="1" r:id="rSheet1"/></sheets></workbook>',
		),
		"xl/_rels/workbook.xml.rels": encoder.encode(
			'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rSheet1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
		),
		"xl/worksheets/sheet1.xml": encoder.encode(
			`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
		),
	});
}

function collect(): void {
	globalThis.gc?.();
}

function measureArchive(payloadBytes: number): TimedBudget {
	const input = documentPackage(paragraphDocument(1), payloadBytes);
	collect();
	const beforeRss = process.memoryUsage().rss;
	const startedAt = performance.now();
	const archive = PackageArchive.open(input);
	const output = archive.serialize();
	const elapsedMs = performance.now() - startedAt;
	const rssDeltaBytes = Math.max(0, process.memoryUsage().rss - beforeRss);
	if (output.byteLength !== input.byteLength) throw new Error("no-op archive size changed");
	return { elapsedMs, rssDeltaBytes };
}

function measureInspect(paragraphs: number): { readonly elapsedMs: number; readonly archive: PackageArchive; readonly snapshot: ReturnType<typeof inspectDocx> } {
	const archive = PackageArchive.open(documentPackage(paragraphDocument(paragraphs)));
	collect();
	const startedAt = performance.now();
	const snapshot = inspectDocx(archive, `performance-${paragraphs}`);
	const elapsedMs = performance.now() - startedAt;
	if (snapshot.paragraphs.length !== paragraphs) throw new Error(`expected ${paragraphs} paragraphs`);
	return { elapsedMs, archive, snapshot };
}

function assertWithin(label: string, actual: number, threshold: number): void {
	if (!Number.isFinite(threshold) || threshold <= 0) throw new Error(`${label}: invalid threshold`);
	if (actual > threshold) throw new Error(`${label}: ${actual.toFixed(3)} exceeds ${threshold}`);
}

const archive10MiB = measureArchive(10 * 1024 * 1024);
const archive50MiB = measureArchive(50 * 1024 * 1024);
const inspect1000 = measureInspect(1000);
const inspect10000 = measureInspect(10000);
const firstRun = inspect10000.snapshot.paragraphs[0]?.runs[0];
if (!firstRun) throw new Error("performance document has no editable run");
const planStartedAt = performance.now();
const plan = planDocx(
	inspect10000.archive,
	inspect10000.snapshot,
	{
		protocolVersion: 1,
		operations: [
			{
				type: "replace_text_run",
				target: { part: "document", paragraphId: inspect10000.snapshot.paragraphs[0].id, runId: firstRun.id },
				precondition: {
					documentRevision: inspect10000.snapshot.revision,
					expectedText: firstRun.text,
					expectedTextSha256: firstRun.anchor.textHash,
				},
				replacement: "Changed paragraph",
			},
		],
	},
	Date.now() + 60000,
);
const committed = commitDocx(inspect10000.archive, inspect10000.snapshot, plan);
const planAndCommit10000ParagraphsMs = performance.now() - planStartedAt;
if (inspectDocx(PackageArchive.open(committed), "performance-reopen").paragraphs[0]?.runs[0]?.text !== "Changed paragraph") {
	throw new Error("performance transaction did not reopen with expected text");
}

const xlsxArchive = PackageArchive.open(spreadsheetPackage(10_000));
collect();
const xlsxInspectStartedAt = performance.now();
const xlsxSnapshot = inspectXlsx(xlsxArchive, "performance-xlsx");
const inspect10000CellsMs = performance.now() - xlsxInspectStartedAt;
const xlsxCell = xlsxSnapshot.sheets[0]?.cells[0];
if (!xlsxCell || xlsxSnapshot.sheets[0]?.cells.length !== 10_000) {
	throw new Error("performance workbook cell count changed");
}
const xlsxPlanStartedAt = performance.now();
const xlsxPlan = planXlsx(
	xlsxArchive,
	xlsxSnapshot,
	{
		protocolVersion: 1,
		operations: [
			{
				type: "set_cell_value",
				target: { sheetId: xlsxSnapshot.sheets[0].id, cellId: xlsxCell.id, address: xlsxCell.address },
				precondition: {
					documentRevision: xlsxSnapshot.revision,
					expectedValue: xlsxCell.value,
					expectedValueSha256: xlsxCell.valueSha256,
				},
				replacement: "Changed cell",
			},
		],
	},
	Date.now() + 60_000,
);
const xlsxCommitted = commitXlsx(xlsxArchive, xlsxSnapshot, xlsxPlan);
const planAndCommit10000CellsMs = performance.now() - xlsxPlanStartedAt;
if (
	inspectXlsx(PackageArchive.open(xlsxCommitted), "performance-xlsx-reopen").sheets[0]?.cells[0]?.value !==
	"Changed cell"
) {
	throw new Error("performance XLSX transaction did not reopen with expected value");
}

const measurements = {
	archive10MiB,
	archive50MiB,
	inspect1000ParagraphsMs: inspect1000.elapsedMs,
	inspect10000ParagraphsMs: inspect10000.elapsedMs,
	planAndCommit10000ParagraphsMs,
	inspect10000CellsMs,
	planAndCommit10000CellsMs,
};
const thresholds = budget.thresholds;
assertWithin("archive10MiB.elapsedMs", archive10MiB.elapsedMs, thresholds.archive10MiB.elapsedMs);
assertWithin("archive10MiB.rssDeltaBytes", archive10MiB.rssDeltaBytes, thresholds.archive10MiB.rssDeltaBytes);
assertWithin("archive50MiB.elapsedMs", archive50MiB.elapsedMs, thresholds.archive50MiB.elapsedMs);
assertWithin("archive50MiB.rssDeltaBytes", archive50MiB.rssDeltaBytes, thresholds.archive50MiB.rssDeltaBytes);
assertWithin("inspect1000ParagraphsMs", inspect1000.elapsedMs, thresholds.inspect1000ParagraphsMs);
assertWithin("inspect10000ParagraphsMs", inspect10000.elapsedMs, thresholds.inspect10000ParagraphsMs);
assertWithin("planAndCommit10000ParagraphsMs", planAndCommit10000ParagraphsMs, thresholds.planAndCommit10000ParagraphsMs);
assertWithin("inspect10000CellsMs", inspect10000CellsMs, thresholds.inspect10000CellsMs);
assertWithin("planAndCommit10000CellsMs", planAndCommit10000CellsMs, thresholds.planAndCommit10000CellsMs);

const report = JSON.stringify(
	{
		schemaVersion: 1,
		node: process.version,
		platform: process.platform,
		architecture: process.arch,
		measurements,
		baseline: budget.baseline,
		thresholds,
	},
	null,
	2,
);
const outputPath = process.argv[2];
if (outputPath) {
	mkdirSync(dirname(resolve(outputPath)), { recursive: true });
	writeFileSync(resolve(outputPath), `${report}\n`);
}
console.log(report);
