export interface StyleProbe {
	readonly text: string;
	readonly bold: boolean;
	readonly italic: boolean;
}

export interface SemanticProbe {
	readonly requiredTexts: readonly string[];
	readonly forbiddenTexts: readonly string[];
	readonly style?: StyleProbe;
}

export type InteropOperation =
	| "replace_text_run"
	| "replace_text_range"
	| "insert_paragraph_after"
	| "delete_paragraph"
	| "set_text_run_style"
	| "replace_related_text_run"
	| "replace_comment_text_run"
	| "no_op";

export interface InteropDefinition {
	readonly id: string;
	readonly sourceFixture: string;
	readonly operation: InteropOperation;
	readonly probe: SemanticProbe;
}

export interface InteropCase extends InteropDefinition {
	readonly generatedSha256: string;
}

export interface InteropManifest {
	readonly schemaVersion: 1;
	readonly generatedAt: string;
	readonly cases: readonly InteropCase[];
}

export const INTEROP_DEFINITIONS: readonly InteropDefinition[] = [
	{
		id: "replace-text-run",
		sourceFixture: "strict-format.docx",
		operation: "replace_text_run",
		probe: { requiredTexts: ["Replaced by pi office engine."], forbiddenTexts: ["Test"] },
	},
	{
		id: "replace-text-range",
		sourceFixture: "open-as-read-only.docx",
		operation: "replace_text_range",
		probe: {
			requiredTexts: ["Externally reopened range."],
			forbiddenTexts: ["This document is opened as read-only, because marked as final in DOCX."],
		},
	},
	{
		id: "insert-paragraph",
		sourceFixture: "strict-format.docx",
		operation: "insert_paragraph_after",
		probe: { requiredTexts: ["Test", "Inserted by pi office engine."], forbiddenTexts: [] },
	},
	{
		id: "delete-paragraph",
		sourceFixture: "strict-format.docx",
		operation: "delete_paragraph",
		probe: { requiredTexts: [], forbiddenTexts: ["Test"] },
	},
	{
		id: "set-run-style",
		sourceFixture: "strict-format.docx",
		operation: "set_text_run_style",
		probe: {
			requiredTexts: ["Test"],
			forbiddenTexts: [],
			style: { text: "Test", bold: true, italic: true },
		},
	},
	{
		id: "replace-header-footer",
		sourceFixture: "header-footer.docx",
		operation: "replace_related_text_run",
		probe: {
			requiredTexts: ["Externally reopened header.", "Externally reopened footer."],
			forbiddenTexts: [
				"This is a simple header, with a € euro symbol in it.",
				"The footer, with Molière, has Unicode in it.",
			],
		},
	},
	{
		id: "replace-comment-text",
		sourceFixture: "comments.docx",
		operation: "replace_comment_text_run",
		probe: {
			requiredTexts: ["Externally reopened comment."],
			forbiddenTexts: ["A tachyon walks into a bar."],
		},
	},
	{
		id: "no-op",
		sourceFixture: "strict-format.docx",
		operation: "no_op",
		probe: { requiredTexts: ["Test"], forbiddenTexts: [] },
	},
];

const SHA256 = /^[0-9a-f]{64}$/;

const record = (value: unknown): Record<string, unknown> => {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Interop manifest object expected");
	return value as Record<string, unknown>;
};

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): void => {
	const actual = Object.keys(value).sort();
	const allowed = [...expected].sort();
	if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
		throw new Error("Interop manifest unknown or missing key");
	}
};

const stringArray = (value: unknown): readonly string[] => {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error("Interop manifest string array expected");
	}
	return value;
};

const parseProbe = (value: unknown): SemanticProbe => {
	const probe = record(value);
	const hasStyle = probe.style !== undefined;
	exactKeys(probe, hasStyle ? ["requiredTexts", "forbiddenTexts", "style"] : ["requiredTexts", "forbiddenTexts"]);
	const result: SemanticProbe = {
		requiredTexts: stringArray(probe.requiredTexts),
		forbiddenTexts: stringArray(probe.forbiddenTexts),
	};
	if (!hasStyle) return result;
	const style = record(probe.style);
	exactKeys(style, ["text", "bold", "italic"]);
	if (typeof style.text !== "string" || typeof style.bold !== "boolean" || typeof style.italic !== "boolean") {
		throw new Error("Interop manifest style invalid");
	}
	return { ...result, style: { text: style.text, bold: style.bold, italic: style.italic } };
};

export function validateInteropManifest(value: unknown): InteropManifest {
	const root = record(value);
	exactKeys(root, ["schemaVersion", "generatedAt", "cases"]);
	if (root.schemaVersion !== 1 || typeof root.generatedAt !== "string" || !Number.isFinite(Date.parse(root.generatedAt))) {
		throw new Error("Interop manifest header invalid");
	}
	if (!Array.isArray(root.cases) || root.cases.length !== INTEROP_DEFINITIONS.length) {
		throw new Error("Interop manifest case count invalid");
	}
	const cases = root.cases.map((raw, index): InteropCase => {
		const item = record(raw);
		exactKeys(item, ["id", "sourceFixture", "operation", "generatedSha256", "probe"]);
		const expected = INTEROP_DEFINITIONS[index];
		if (
			item.id !== expected.id ||
			item.sourceFixture !== expected.sourceFixture ||
			item.operation !== expected.operation ||
			typeof item.generatedSha256 !== "string" ||
			!SHA256.test(item.generatedSha256)
		) {
			throw new Error(`Interop manifest case ${index} invalid`);
		}
		const probe = parseProbe(item.probe);
		if (JSON.stringify(probe) !== JSON.stringify(expected.probe)) {
			throw new Error(`Interop manifest probe ${expected.id} invalid`);
		}
		return { ...expected, generatedSha256: item.generatedSha256 };
	});
	return { schemaVersion: 1, generatedAt: root.generatedAt, cases };
}
