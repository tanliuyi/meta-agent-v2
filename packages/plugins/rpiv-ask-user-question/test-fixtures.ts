import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	RegisteredCommand,
	SessionEntry,
	ToolDefinition,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { QuestionnaireState } from "./state/state";
import type { ApplyContext } from "./state/state-reducer";
import type { QuestionData } from "./tool/types";
import type { MultiSelectView, MultiSelectViewProps } from "./view/components/multi-select-view";
import type { PreviewPane, PreviewPaneProps } from "./view/components/preview/preview-pane";
import type { SubmitPickerProps } from "./view/components/submit-picker";
import type { WrappingSelectItem } from "./view/components/wrapping-select";
import type { StatefulView } from "./view/stateful-view";
import type { TabComponents } from "./view/tab-components";
import { type MockInstance, vi } from "vitest";

export interface CapturedPi {
	tools: Map<string, ToolDefinition>;
	commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
	flags: Map<string, unknown>;
	events: Map<string, Array<(...args: unknown[]) => unknown>>;
	eventsEmitted: Map<string, unknown[]>;
	activeTools: string[];
	allTools: ToolInfo[];
}

export function createMockPi(options: Partial<ExtensionAPI> = {}): { pi: ExtensionAPI; captured: CapturedPi } {
	const captured: CapturedPi = {
		tools: new Map(),
		commands: new Map(),
		flags: new Map(),
		events: new Map(),
		eventsEmitted: new Map(),
		activeTools: [],
		allTools: [],
	};
	const pi = {
		registerTool: vi.fn((tool: ToolDefinition) => {
			captured.tools.set(tool.name, tool);
			if (!captured.activeTools.includes(tool.name)) captured.activeTools.push(tool.name);
		}),
		registerCommand: vi.fn((name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			captured.commands.set(name, command);
		}),
		registerShortcut: vi.fn(),
		registerFlag: vi.fn((name: string, value: unknown) => captured.flags.set(name, value)),
		getFlag: vi.fn((name: string) => captured.flags.get(name)),
		on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
			const handlers = captured.events.get(event) ?? [];
			handlers.push(handler);
			captured.events.set(event, handlers);
		}),
		sendMessage: vi.fn(async () => undefined),
		sendUserMessage: vi.fn(),
		exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0, killed: false })),
		getActiveTools: vi.fn(() => [...captured.activeTools]),
		setActiveTools: vi.fn((names: string[]) => {
			captured.activeTools = [...names];
		}),
		getAllTools: vi.fn(() => [...captured.allTools]),
		getThinkingLevel: vi.fn(() => "medium"),
		events: {
			emit: vi.fn((channel: string, data: unknown) => {
				const emitted = captured.eventsEmitted.get(channel) ?? [];
				emitted.push(data);
				captured.eventsEmitted.set(channel, emitted);
			}),
			on: vi.fn(() => () => undefined),
		},
		getCommands: vi.fn(() => []),
		...options,
	} as unknown as ExtensionAPI;
	return { pi, captured };
}

function createMockUI(overrides: Partial<ExtensionUIContext> = {}): ExtensionUIContext {
	return {
		notify: vi.fn(),
		confirm: vi.fn(async () => true),
		input: vi.fn(async () => ""),
		select: vi.fn(async () => undefined),
		setWidget: vi.fn(),
		setStatus: vi.fn(),
		setWorkingMessage: vi.fn(),
		setHiddenThinkingLabel: vi.fn(),
		onTerminalInput: vi.fn(() => () => undefined),
		pasteToEditor: vi.fn(),
		setEditorComponent: vi.fn(),
		...overrides,
	} as unknown as ExtensionUIContext;
}

function createMockSessionManager(branch: SessionEntry[] = []) {
	return {
		getBranch: vi.fn(() => branch),
		getEntries: vi.fn(() => branch),
		getLeafId: vi.fn(() => (branch.length ? branch[branch.length - 1].id : null)),
		getSessionFile: vi.fn(() => "/tmp/test-session.jsonl"),
		getSessionId: vi.fn(() => "test-session"),
	};
}

export function createMockCtx(opts: {
	hasUI?: boolean;
	mode?: string;
	cwd?: string;
	model?: Model<Api>;
	branch?: SessionEntry[];
	models?: Model<Api>[];
	ui?: Partial<ExtensionUIContext>;
} = {}): ExtensionContext {
	return {
		hasUI: opts.hasUI ?? false,
		mode: opts.mode,
		cwd: opts.cwd ?? "/tmp/test-cwd",
		model: opts.model,
		ui: createMockUI(opts.ui),
		sessionManager: createMockSessionManager(opts.branch),
		modelRegistry: {
			find: vi.fn((provider: string, id: string) =>
				opts.models?.find((model) => model.provider === provider && model.id === id),
			),
			getAvailable: vi.fn(() => [...(opts.models ?? [])]),
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test-key", headers: {} })),
		},
		isIdle: vi.fn(() => true),
		isProjectTrusted: vi.fn(() => true),
	} as unknown as ExtensionContext;
}

export interface MockTheme {
	fg: (_color: string, text: string) => string;
	bg: (_color: string, text: string) => string;
	bold: (text: string) => string;
	strikethrough: (text: string) => string;
}

export function makeTheme(overrides: Partial<MockTheme> = {}): MockTheme {
	return {
		fg: (_color, text) => text,
		bg: (_color, text) => text,
		bold: (text) => text,
		strikethrough: (text) => text,
		...overrides,
	};
}

export function makeTui(): { requestRender: ReturnType<typeof vi.fn> } {
	return { requestRender: vi.fn() };
}

export function mockStdout(isTTY: boolean | (() => boolean)): {
	stdoutWrite: MockInstance<typeof process.stdout.write>;
	restore: () => void;
} {
	const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	Object.defineProperty(
		process.stdout,
		"isTTY",
		typeof isTTY === "function" ? { get: isTTY, configurable: true } : { value: isTTY, configurable: true },
	);
	return {
		stdoutWrite,
		restore: () => {
			stdoutWrite.mockRestore();
			if (descriptor) Object.defineProperty(process.stdout, "isTTY", descriptor);
			else delete (process.stdout as { isTTY?: boolean }).isTTY;
		},
	};
}

const SKIP_DIRS = new Set(["node_modules", "docs"]);
const SKIP_FILES = new Set(["test-fixtures.ts"]);

export function verifyShipManifest(packageDirOrUrl: string): {
	declared: readonly string[];
	onDisk: readonly string[];
	missing: readonly string[];
	stale: readonly string[];
} {
	const packageDir = packageDirOrUrl.startsWith("file:") ? dirname(fileURLToPath(packageDirOrUrl)) : packageDirOrUrl;
	const pkg = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8")) as { files?: string[] };
	const declared = pkg.files ?? [];
	const exactFiles = new Set<string>();
	const directoryPrefixes: string[] = [];
	for (const entry of declared) {
		if (entry.startsWith("!")) continue;
		if (entry.endsWith("/") || isDirectory(packageDir, entry)) directoryPrefixes.push(`${entry.replace(/\/$/, "")}/`);
		else exactFiles.add(entry);
	}
	const onDisk = walkProductionTs(packageDir, packageDir);
	const missing = onDisk.filter(
		(file) => !exactFiles.has(file) && !directoryPrefixes.some((prefix) => file.startsWith(prefix)),
	);
	const stale = declared.filter((entry) => !entry.startsWith("!") && !existsSync(resolve(packageDir, entry)));
	return { declared, onDisk, missing, stale };
}

function isDirectory(packageDir: string, entry: string): boolean {
	try {
		return statSync(resolve(packageDir, entry)).isDirectory();
	} catch {
		return false;
	}
}

function walkProductionTs(root: string, directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || (entry.isDirectory() && SKIP_DIRS.has(entry.name))) continue;
		const absolutePath = resolve(directory, entry.name);
		if (entry.isDirectory()) files.push(...walkProductionTs(root, absolutePath));
		else if (
			entry.isFile() &&
			entry.name.endsWith(".ts") &&
			!entry.name.endsWith(".test.ts") &&
			!SKIP_FILES.has(entry.name)
		) {
			files.push(relative(root, absolutePath));
		}
	}
	return files;
}

export const itemsRegular: ReadonlyArray<WrappingSelectItem> = [
	{ kind: "option", label: "A" },
	{ kind: "option", label: "B" },
];

export const itemsWithOther: ReadonlyArray<WrappingSelectItem> = [
	...itemsRegular,
	{ kind: "other", label: "Type something." },
];

export function makeQuestion(overrides: Partial<QuestionData> = {}): QuestionData {
	return {
		question: overrides.question ?? "Pick one",
		header: overrides.header ?? "H",
		options: overrides.options ?? [
			{ label: "A", description: "a" },
			{ label: "B", description: "b" },
		],
		multiSelect: overrides.multiSelect,
	};
}

export function makeQuestionnaireState(overrides: Partial<QuestionnaireState> = {}): QuestionnaireState {
	return {
		currentTab: overrides.currentTab ?? 0,
		optionIndex: overrides.optionIndex ?? 0,
		inputMode: overrides.inputMode ?? false,
		notesVisible: overrides.notesVisible ?? false,
		answers: overrides.answers ?? new Map(),
		multiSelectChecked: overrides.multiSelectChecked ?? new Set(),
		customDraftsByTab: overrides.customDraftsByTab ?? new Map(),
		notesByTab: overrides.notesByTab ?? new Map(),
		submitChoiceIndex: overrides.submitChoiceIndex ?? 0,
		notesDraft: overrides.notesDraft ?? "",
		collapsed: overrides.collapsed ?? false,
	};
}

export function makeApplyContext(overrides: Partial<ApplyContext> = {}): ApplyContext {
	const questions = overrides.questions ?? [makeQuestion()];
	return {
		questions,
		itemsByTab: overrides.itemsByTab ?? questions.map(() => itemsRegular),
	};
}

export function makeStatefulView<P>(): StatefulView<P> {
	return {
		setProps: vi.fn(),
		render: () => [],
		invalidate: () => undefined,
		handleInput: () => undefined,
	};
}

export function makeFakePreviewPane(): PreviewPane {
	return {
		...makeStatefulView<PreviewPaneProps>(),
		setGlobalLeftWidth: vi.fn(),
	} as unknown as PreviewPane;
}

export function makeFakeMultiSelectView(): MultiSelectView {
	return {
		...makeStatefulView<MultiSelectViewProps>(),
		focusedItemRowRange: () => [0, 0] as [number, number],
		naturalHeight: () => 0,
	} as unknown as MultiSelectView;
}

export function makeTabComponents(overrides: Partial<TabComponents> = {}): TabComponents {
	return {
		optionList: overrides.optionList ?? makeStatefulView(),
		preview: overrides.preview ?? makeFakePreviewPane(),
		multiSelect: overrides.multiSelect,
		bodyHeights: overrides.bodyHeights ?? (() => ({ current: 0, max: 0 })),
	};
}

export function makeMultiSelectViewProps(
	question: QuestionData,
	overrides: {
		optionIndex?: number;
		checkedIndices?: ReadonlySet<number>;
		focused?: boolean;
		nextLabel?: string;
		inputBuffer?: string;
		inputCursorOffset?: number;
		inputMode?: boolean;
	} = {},
): MultiSelectViewProps {
	const optionIndex = overrides.optionIndex ?? 0;
	const checkedIndices = overrides.checkedIndices ?? new Set<number>();
	const focused = overrides.focused ?? true;
	const inputBuffer = overrides.inputBuffer ?? "";
	const rows = question.options.map((_, index) => ({
		checked: checkedIndices.has(index),
		active: focused && index === optionIndex,
	}));
	const otherActive = focused && optionIndex === question.options.length;
	return {
		rows,
		other: {
			active: otherActive,
			inputMode: (overrides.inputMode ?? false) && otherActive,
			inputBuffer,
			inputCursorOffset: overrides.inputCursorOffset,
		},
		nextActive: focused && optionIndex === question.options.length + 1,
		nextLabel: overrides.nextLabel ?? "Next",
	};
}

export function makeMultiSelectPropsFromState(
	question: QuestionData,
	state: QuestionnaireState,
	focused = true,
): MultiSelectViewProps {
	const rows = question.options.map((_, index) => ({
		checked: state.multiSelectChecked.has(index),
		active: focused && index === state.optionIndex,
	}));
	return {
		rows,
		other: {
			active: focused && state.optionIndex === question.options.length,
			inputMode: state.inputMode,
			inputBuffer: "",
			inputCursorOffset: undefined,
		},
		nextActive: focused && state.optionIndex === question.options.length + 1,
		nextLabel: "Next",
	};
}

export function makeSubmitPickerPropsFromState(
	state: QuestionnaireState,
	focused = true,
): SubmitPickerProps {
	return {
		rows: [
			{ active: focused && state.submitChoiceIndex === 0 },
			{ active: focused && state.submitChoiceIndex === 1 },
		],
	};
}
