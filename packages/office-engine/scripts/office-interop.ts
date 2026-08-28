import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertCorpusAdmission } from "./corpus-admission.ts";
import {
	INTEROP_DEFINITIONS,
	type InteropCase,
	type InteropManifest,
	type SemanticProbe,
	validateInteropManifest,
} from "./interop-manifest.ts";
import {
	commitDocx,
	inspectDocx,
	PackageArchive,
	planDocx,
	sha256Hex,
	type DocumentOperation,
	type DocxInspectSnapshot,
} from "../src/index.ts";

const packageRoot = resolve(import.meta.dirname, "..");
const defaultWorkDir = resolve(packageRoot, ".interop");

const paragraphText = (paragraph: { readonly runs: readonly { readonly text: string }[] }): string =>
	paragraph.runs.map((run) => run.text).join("");

const editableParagraph = (snapshot: DocxInspectSnapshot) => {
	const paragraph = snapshot.paragraphs.find((candidate) => candidate.editable);
	if (!paragraph) throw new Error("Fixture does not contain an editable paragraph");
	return paragraph;
};

const firstRun = (snapshot: DocxInspectSnapshot) => {
	const paragraph = editableParagraph(snapshot);
	const run = paragraph.runs.find((candidate) => candidate.editable);
	if (!run) throw new Error("Fixture does not contain an editable run");
	return { paragraph, run };
};

const buildOperations = (caseId: string, snapshot: DocxInspectSnapshot): readonly DocumentOperation[] => {
	if (caseId === "replace-comment-text") {
		const comment = snapshot.comments.find((candidate) =>
			candidate.paragraphs.some((paragraph) => paragraph.runs.some((run) => run.editable)),
		);
		const paragraph = comment?.paragraphs.find((candidate) => candidate.runs.some((run) => run.editable));
		const run = paragraph?.runs.find((candidate) => candidate.editable);
		if (!comment || !paragraph || !run) throw new Error("Comments fixture lacks an editable text run");
		return [
			{
				type: "replace_comment_text_run",
				target: { part: "comments", commentId: comment.id, paragraphId: paragraph.id, runId: run.id },
				precondition: {
					documentRevision: snapshot.revision,
					expectedText: run.text,
					expectedTextSha256: run.anchor.textHash,
				},
				replacement: "Externally reopened comment.",
			},
		];
	}
	if (caseId === "replace-header-footer") {
		return (["header", "footer"] as const).map((kind): DocumentOperation => {
			const part = snapshot.relatedParts.find(
				(candidate) => candidate.kind === kind && candidate.paragraphs.some((paragraph) => paragraph.runs.some((run) => run.editable)),
			);
			const paragraph = part?.paragraphs.find((candidate) => candidate.runs.some((run) => run.editable));
			const run = paragraph?.runs.find((candidate) => candidate.editable);
			if (!part || !paragraph || !run) throw new Error(`Header/footer fixture lacks an editable ${kind} run`);
			return {
				type: "replace_related_text_run",
				target: { part: kind, relatedPartId: part.id, paragraphId: paragraph.id, runId: run.id },
				precondition: {
					documentRevision: snapshot.revision,
					expectedText: run.text,
					expectedTextSha256: run.anchor.textHash,
				},
				replacement: kind === "header" ? "Externally reopened header." : "Externally reopened footer.",
			};
		});
	}
	const { paragraph, run } = firstRun(snapshot);
	const precondition = {
		documentRevision: snapshot.revision,
		expectedText: run.text,
		expectedTextSha256: run.anchor.textHash,
	};
	if (caseId === "replace-text-run") {
		return [{
			type: "replace_text_run",
			target: { part: "document", paragraphId: paragraph.id, runId: run.id },
			precondition,
			replacement: "Replaced by pi office engine.",
		}];
	}
	if (caseId === "replace-text-range") {
		const runs = paragraph.runs.filter((candidate) => candidate.editable);
		const last = runs.at(-1);
		if (!last || runs.length < 2) throw new Error("Range fixture must contain at least two editable runs");
		const expectedText = paragraphText(paragraph);
		return [{
			type: "replace_text_range",
			target: {
				part: "document",
				paragraphId: paragraph.id,
				start: { runId: run.id, offset: 0 },
				end: { runId: last.id, offset: last.text.length },
			},
			precondition: {
				documentRevision: snapshot.revision,
				expectedText,
				expectedTextSha256: paragraph.anchor.textHash,
			},
			replacement: "Externally reopened range.",
		}];
	}
	if (caseId === "insert-paragraph") {
		const expectedText = paragraphText(paragraph);
		return [{
			type: "insert_paragraph_after",
			target: { part: "document", paragraphId: paragraph.id },
			precondition: {
				documentRevision: snapshot.revision,
				expectedText,
				expectedTextSha256: paragraph.anchor.textHash,
			},
			replacement: "Inserted by pi office engine.",
		}];
	}
	if (caseId === "delete-paragraph") {
		const expectedText = paragraphText(paragraph);
		return [{
			type: "delete_paragraph",
			target: { part: "document", paragraphId: paragraph.id },
			precondition: {
				documentRevision: snapshot.revision,
				expectedText,
				expectedTextSha256: paragraph.anchor.textHash,
			},
		}];
	}
	if (caseId === "set-run-style") {
		return [{
			type: "set_text_run_style",
			target: { part: "document", paragraphId: paragraph.id, runId: run.id },
			precondition: {
				...precondition,
				expectedProperties: {
					bold: run.properties.bold === true,
					italic: run.properties.italic === true,
					...(run.properties.styleId === undefined ? {} : { styleId: run.properties.styleId }),
				},
			},
			replacement: { bold: true, italic: true },
		}];
	}
	if (caseId === "no-op") return [];
	throw new Error(`Unknown interoperability case: ${caseId}`);
};

const generate = async (workDir: string): Promise<void> => {
	await rm(workDir, { recursive: true, force: true });
	await mkdir(resolve(workDir, "inputs"), { recursive: true });
	const { root: corpusDir, manifest: corpusManifest } = assertCorpusAdmission();
	const admittedFixtures = new Set(corpusManifest.fixtures.map((entry) => entry.filename));
	const cases: InteropCase[] = [];
	for (const definition of INTEROP_DEFINITIONS) {
		if (!admittedFixtures.has(definition.sourceFixture)) {
			throw new Error(`Interop fixture is not admitted: ${definition.sourceFixture}`);
		}
		const source = new Uint8Array(await readFile(resolve(corpusDir, definition.sourceFixture)));
		const archive = PackageArchive.open(source);
		const snapshot = inspectDocx(archive, `interop-${definition.id}`);
		const operations = buildOperations(definition.id, snapshot);
		const operationType = operations[0]?.type ?? "no_op";
		if (operationType !== definition.operation || operations.some((operation) => operation.type !== definition.operation)) {
			throw new Error(`${definition.id}: constructed ${operationType}, expected ${definition.operation}`);
		}
		const plan = planDocx(
			archive,
			snapshot,
			{ protocolVersion: 1, operations },
			Date.now() + 60_000,
		);
		const output = commitDocx(archive, snapshot, plan);
		if (operations.length === 0 && Buffer.compare(Buffer.from(source), Buffer.from(output)) !== 0) {
			throw new Error("No-op transaction changed package bytes");
		}
		const reopened = PackageArchive.open(output);
		verifySnapshot(inspectDocx(reopened, `interop-${definition.id}-generated`), definition.probe, definition.id);
		await writeFile(resolve(workDir, "inputs", `${definition.id}.docx`), output);
		cases.push({ ...definition, generatedSha256: sha256Hex(output) });
	}
	const manifest: InteropManifest = {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		cases,
	};
	validateInteropManifest(manifest);
	await writeFile(resolve(workDir, "manifest.json"), `${JSON.stringify(manifest, undefined, 2)}\n`);
	console.log(`Generated ${cases.length} DOCX interoperability cases in ${workDir}`);
};

const verifySnapshot = (snapshot: DocxInspectSnapshot, probe: SemanticProbe, caseId: string): void => {
	const relatedText = snapshot.relatedParts.flatMap((part) => part.paragraphs).map(paragraphText).join("\n");
	const commentText = snapshot.comments.flatMap((comment) => comment.paragraphs).map(paragraphText).join("\n");
	const text = `${snapshot.paragraphs.map(paragraphText).join("\n")}\n${relatedText}\n${commentText}`;
	for (const required of probe.requiredTexts) {
		if (!text.includes(required)) throw new Error(`${caseId}: required text is missing: ${required}; actual text: ${JSON.stringify(text)}`);
	}
	for (const forbidden of probe.forbiddenTexts) {
		if (text.includes(forbidden)) throw new Error(`${caseId}: forbidden text remains: ${forbidden}`);
	}
	if (probe.style) {
		const run = snapshot.paragraphs.flatMap((paragraph) => paragraph.runs).find((candidate) => candidate.text === probe.style?.text);
		if (!run) throw new Error(`${caseId}: styled run is missing: ${probe.style.text}`);
		if (run.properties.bold !== probe.style.bold || run.properties.italic !== probe.style.italic) {
			throw new Error(`${caseId}: run style changed after external reopen`);
		}
	}
};

const readManifest = async (workDir: string): Promise<InteropManifest> =>
	validateInteropManifest(JSON.parse(await readFile(resolve(workDir, "manifest.json"), "utf8")));

const validateInputs = async (workDir: string): Promise<InteropManifest> => {
	const manifest = await readManifest(workDir);
	for (const entry of manifest.cases) {
		const bytes = new Uint8Array(await readFile(resolve(workDir, "inputs", `${entry.id}.docx`)));
		if (sha256Hex(bytes) !== entry.generatedSha256) throw new Error(`${entry.id}: generated input hash mismatch`);
	}
	return manifest;
};

const verify = async (workDir: string, provider: "libreoffice" | "word"): Promise<void> => {
	const manifest = await validateInputs(workDir);
	const reopenedDir = resolve(workDir, "reopened", provider);
	for (const entry of manifest.cases) {
		const path = resolve(reopenedDir, `${entry.id}.docx`);
		const bytes = new Uint8Array(await readFile(path));
		verifySnapshot(inspectDocx(PackageArchive.open(bytes), `${provider}-${entry.id}`), entry.probe, entry.id);
	}
	console.log(`Verified ${manifest.cases.length} ${provider} DOCX interoperability cases`);
};

const [command, workDirArgument, providerArgument] = process.argv.slice(2);
const workDir = resolve(workDirArgument ?? defaultWorkDir);
if (command === "generate") {
	await generate(workDir);
} else if (command === "validate") {
	await validateInputs(workDir);
	console.log(`Validated interoperability manifest and inputs in ${workDir}`);
} else if (command === "verify") {
	if (providerArgument !== "libreoffice" && providerArgument !== "word") {
		throw new Error("Usage: office-interop.ts verify [work-dir] <libreoffice|word>");
	}
	await verify(workDir, providerArgument);
} else {
	throw new Error("Usage: office-interop.ts <generate|validate|verify> [work-dir] [provider]");
}
