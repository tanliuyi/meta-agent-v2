import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertCorpusAdmission,
	loadCorpus,
	validateCorpusDirectory,
	validateCorpusManifest,
} from "../scripts/corpus-admission.ts";
import {
	commitDocx,
	inspectDocx,
	OfficeEngineError,
	PackageArchive,
	planDocx,
	sha256Hex,
	verifyReplacement,
} from "../src/index.ts";

const enc = new TextEncoder();

describe("P1 hash and corpus contracts", () => {
	it("uses standard SHA-256 vectors", () => {
		expect(sha256Hex(enc.encode(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
		expect(sha256Hex(enc.encode("Hello"))).toBe("185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969");
		expect(sha256Hex(enc.encode("你好，世界"))).toBe(
			"46932f1e6ea5216e77f58b1908d72ec9322ed129318c6d4bd4450b5eaab9d7e7",
		);
	});
	it("admits only manifest-listed files and verifies license, hashes, warnings, and run expectations", () => {
		const { root, manifest } = assertCorpusAdmission();
		for (const entry of manifest.fixtures) {
			const bytes = new Uint8Array(readFileSync(resolve(root, entry.filename))),
				archive = PackageArchive.open(bytes),
				snapshot = inspectDocx(archive, entry.filename);
			expect(sha256Hex(bytes)).toBe(entry.sha256);
			expect(snapshot.mainPart).toBe(entry.format.mainPart);
			expect(snapshot.warnings.map(({ code, part }) => ({ code, part }))).toEqual(entry.expected.warnings);
			if (entry.expected.operation === "blocked")
				expect(
					snapshot.paragraphs.some((paragraph) => paragraph.blockedReason === entry.expected.blockedReason),
				).toBe(true);
			if (entry.expected.editableRun) {
				const run = snapshot.paragraphs
					.find((p) => p.id === entry.expected.editableRun?.paragraphId)
					?.runs.find((r) => r.id === entry.expected.editableRun?.runId);
				expect(run?.text).toBe(entry.expected.editableRun.text);
				expect(run?.editable).toBe(entry.expected.operation === "editable");
			} else if (entry.expected.editableRelatedRun) {
				const target = entry.expected.editableRelatedRun;
				const run = snapshot.relatedParts
					.find((part) => part.id === target.relatedPartId && part.kind === target.part)
					?.paragraphs.find((paragraph) => paragraph.id === target.paragraphId)
					?.runs.find((candidate) => candidate.id === target.runId);
				expect(run?.text).toBe(target.text);
				expect(run?.editable).toBe(entry.expected.operation === "editable");
			} else expect(entry.expected.operation).toBe("blocked");
		}
	});
	it("performs strict-format inspect, replace, reopen, identity, semantic diff, ZIP delta, and zero-op proof", () => {
		const { root, manifest } = loadCorpus(),
			entry = manifest.fixtures.find((item) => item.filename === "strict-format.docx")!;
		const source = new Uint8Array(readFileSync(resolve(root, entry.filename))),
			archive = PackageArchive.open(source),
			snapshot = inspectDocx(archive, entry.filename),
			target = entry.expected.editableRun!;
		const run = snapshot.paragraphs[0].runs[0];
		const plan = planDocx(
			archive,
			snapshot,
			{
				protocolVersion: 1,
				operations: [
					{
						type: "replace_text_run",
						target: { part: "document", paragraphId: target.paragraphId, runId: target.runId },
						precondition: {
							documentRevision: 1,
							expectedText: target.text,
							expectedTextSha256: run.anchor.textHash,
						},
						replacement: "Replaced",
					},
				],
			},
			Date.now() + 10000,
		);
		expect(plan.baseRevision).toBe(1);
		expect(plan.resultingRevision).toBe(2);
		expect(plan.touchedRuns).toEqual([target.runId]);
		expect(plan.touchedParts).toEqual([entry.format.mainPart]);
		expect(plan.semanticDiff).toEqual([{ runId: target.runId, before: target.text, after: "Replaced" }]);
		const output = commitDocx(archive, snapshot, plan),
			reopenedArchive = PackageArchive.open(output),
			reopened = inspectDocx(reopenedArchive, entry.filename, 2);
		expect(reopened.paragraphs[0].runs[0].id).toBe(target.runId);
		expect(reopened.paragraphs[0].runs[0].text).toBe("Replaced");
		expect(
			verifyReplacement(source, output, entry.format.mainPart, reopenedArchive.read(entry.format.mainPart))
				.changedEntries,
		).toEqual([entry.format.mainPart]);
		for (const item of archive.entries())
			if (item.path !== entry.format.mainPart)
				expect(reopenedArchive.read(item.path)).toEqual(archive.read(item.path));
		expect(
			commitDocx(
				archive,
				snapshot,
				planDocx(archive, snapshot, { protocolVersion: 1, operations: [] }, Date.now() + 10000),
			),
		).toEqual(source);
	});
	it("roundtrips the LibreOffice fixture and preserves the second identical World", () => {
		const { root, manifest } = assertCorpusAdmission(),
			entry = manifest.fixtures.find((item) => item.filename === "bug66312.docx")!,
			source = new Uint8Array(readFileSync(resolve(root, entry.filename))),
			archive = PackageArchive.open(source),
			snapshot = inspectDocx(archive, entry.filename),
			runs = snapshot.paragraphs.flatMap((paragraph) => paragraph.runs).filter((item) => item.text === "World"),
			run = runs[0];
		expect(runs).toHaveLength(2);
		expect(run.id).toBe("r-0-0");
		expect(run.text).toBe("World");
		const secondRaw = archive.read(entry.format.mainPart).slice(runs[1].anchor.start, runs[1].anchor.end);
		expect(new TextDecoder().decode(archive.read(entry.format.mainPart)).match(/World/g)).toHaveLength(2);
		const plan = planDocx(
			archive,
			snapshot,
			{
				protocolVersion: 1,
				operations: [
					{
						type: "replace_text_run",
						target: { part: "document", paragraphId: "p-0", runId: "r-0-0" },
						precondition: { documentRevision: 1, expectedText: "World", expectedTextSha256: run.anchor.textHash },
						replacement: "Earth",
					},
				],
			},
			Date.now() + 10000,
		);
		const output = commitDocx(archive, snapshot, plan),
			reopenedArchive = PackageArchive.open(output),
			reopened = inspectDocx(reopenedArchive, entry.filename, 2);
		expect(plan.semanticDiff).toEqual([{ runId: "r-0-0", before: "World", after: "Earth" }]);
		expect(plan.patchManifest).toHaveLength(1);
		expect(plan.patchManifest[0].start).toBe(runs[0].anchor.start);
		expect(plan.patchManifest[0].end).toBe(runs[0].anchor.end);
		expect(
			reopened.paragraphs.flatMap((paragraph) => paragraph.runs).find((item) => item.id === runs[1].id)?.text,
		).toBe("World");
		const reopenedSecond = reopenedArchive
			.read(entry.format.mainPart)
			.slice(runs[1].anchor.start, runs[1].anchor.end);
		expect(reopenedSecond).toEqual(secondRaw);
		expect(reopened.paragraphs.find((paragraph) => paragraph.id === "p-0")!.runs[0].text).toBe("Earth");
		expect(
			commitDocx(
				reopenedArchive,
				reopened,
				planDocx(reopenedArchive, reopened, { protocolVersion: 1, operations: [] }, Date.now() + 10000),
			),
		).toEqual(output);
		expect(
			commitDocx(
				archive,
				snapshot,
				planDocx(archive, snapshot, { protocolVersion: 1, operations: [] }, Date.now() + 10000),
			),
		).toEqual(source);
	});
	it("roundtrips a cross-run range in a LibreOffice-produced corpus fixture", () => {
		const { root, manifest } = assertCorpusAdmission();
		const entry = manifest.fixtures.find((item) => item.filename === "open-as-read-only.docx")!;
		const source = new Uint8Array(readFileSync(resolve(root, entry.filename)));
		const archive = PackageArchive.open(source);
		const snapshot = inspectDocx(archive, entry.filename);
		const paragraph = snapshot.paragraphs.find((item) => item.id === "p-0")!;
		const [first, middle, last] = paragraph.runs;
		expect(paragraph.runs.map((run) => run.text)).toEqual([
			"This document is ",
			"opened as read-only, because ",
			"marked as final in ",
			"DOCX.",
		]);
		const expectedText = "document is opened as read-only, because marked";
		const plan = planDocx(
			archive,
			snapshot,
			{
				protocolVersion: 1,
				operations: [
					{
						type: "replace_text_range",
						target: {
							part: "document",
							paragraphId: paragraph.id,
							start: { runId: first.id, offset: 5 },
							end: { runId: last.id, offset: 6 },
						},
						precondition: {
							documentRevision: snapshot.revision,
							expectedText,
							expectedTextSha256: sha256Hex(enc.encode(expectedText)),
						},
						replacement: "file remains",
					},
				],
			},
			Date.now() + 10_000,
		);
		expect(plan.patchManifest).toHaveLength(3);
		expect(plan.semanticDiff).toEqual([
			{ runId: first.id, before: "This document is ", after: "This file remains" },
			{ runId: middle.id, before: "opened as read-only, because ", after: "" },
			{ runId: last.id, before: "marked as final in ", after: " as final in " },
		]);
		const markedAsFinal = archive.read("docProps/custom.xml");
		const output = commitDocx(archive, snapshot, plan);
		const reopenedArchive = PackageArchive.open(output);
		const reopened = inspectDocx(reopenedArchive, entry.filename, plan.resultingRevision);
		expect(reopened.paragraphs[0].runs.map((run) => run.text)).toEqual([
			"This file remains",
			"",
			" as final in ",
			"DOCX.",
		]);
		expect(reopenedArchive.read("docProps/custom.xml")).toEqual(markedAsFinal);
		expect(
			verifyReplacement(source, output, entry.format.mainPart, reopenedArchive.read(entry.format.mainPart))
				.changedEntries,
		).toEqual([entry.format.mainPart]);
		for (const item of archive.entries())
			if (item.path !== entry.format.mainPart)
				expect(reopenedArchive.read(item.path)).toEqual(archive.read(item.path));
	});

	it("asserts real comments and footnotes warnings map to their non-main parts", () => {
		const { root } = loadCorpus();
		for (const [filename, expected] of [
			["comments.docx", ["BLOCKED_CONTENT:word/comments.xml"]],
			["footnotes.docx", ["UNSUPPORTED_ENDNOTE:word/endnotes.xml", "UNSUPPORTED_FOOTNOTE:word/footnotes.xml"]],
		] as const) {
			const snapshot = inspectDocx(
				PackageArchive.open(new Uint8Array(readFileSync(resolve(root, filename)))),
				filename,
			);
			expect(
				snapshot.warnings.filter((w) => w.part !== snapshot.mainPart).map((w) => `${w.code}:${w.part}`),
			).toEqual(expected);
		}
	});
	it("rejects unknown keys, bad hashes, duplicates, unlisted/missing paths, traversal, producer, and expectation", () => {
		const manifest = loadCorpus().manifest as unknown as Record<string, unknown>,
			fixtures = manifest.fixtures as unknown[];
		const valid = loadCorpus().manifest as unknown as Record<string, unknown>,
			validFixtures = valid.fixtures as unknown[];
		const extra = { ...(validFixtures[0] as object), filename: "unlisted.docx" };
		expect(() =>
			validateCorpusDirectory(loadCorpus().root, { ...valid, fixtures: [...validFixtures, extra] } as never),
		).toThrow();
		expect(() =>
			validateCorpusDirectory(loadCorpus().root, { ...valid, fixtures: validFixtures.slice(1) } as never),
		).toThrow();
		for (const value of [
			{ ...manifest, unknown: true },
			{ ...manifest, licenseSha256: "0" },
			{ ...manifest, fixtures: [...fixtures, fixtures[0]] },
			{ ...manifest, fixtures: [{ ...(fixtures[0] as object), filename: "../evil.docx" }] },
			{ ...manifest, fixtures: [{ ...(fixtures[0] as object), producer: { name: "Word", version: "" } }] },
			{
				...manifest,
				fixtures: [
					{
						...(fixtures[0] as object),
						expected: { inspect: "opens", warnings: [], operation: "blocked", blockedReason: "unknown" },
					},
				],
			},
			{
				...manifest,
				fixtures: [
					{ ...(fixtures[0] as object), expected: { inspect: "wat", warnings: [], operation: "blocked" } },
				],
			},
		])
			expect(() => validateCorpusManifest(value)).toThrow();
	});
	it("keeps single-paragraph bookmark boundary blocked", () => {
		const { root, manifest } = loadCorpus(),
			entry = manifest.fixtures.find((item) => item.filename === "single-paragraph.docx")!,
			archive = PackageArchive.open(new Uint8Array(readFileSync(resolve(root, entry.filename)))),
			snapshot = inspectDocx(archive, entry.filename),
			target = entry.expected.editableRun!;
		expect(snapshot.paragraphs[0].runs[0].id).toBe(target.runId);
		expect(snapshot.paragraphs[0].runs[0].editable).toBe(false);
		expect(snapshot.paragraphs[0].runs[0].blockedReason).toBe(entry.expected.blockedReason);
		expect(() =>
			planDocx(
				archive,
				snapshot,
				{
					protocolVersion: 1,
					operations: [
						{
							type: "replace_text_run",
							target: { part: "document", paragraphId: target.paragraphId, runId: target.runId },
							precondition: {
								documentRevision: 1,
								expectedText: target.text,
								expectedTextSha256: snapshot.paragraphs[0].runs[0].anchor.textHash,
							},
							replacement: "blocked",
						},
					],
				},
				Date.now() + 10000,
			),
		).toThrowError(OfficeEngineError);
	});
});
