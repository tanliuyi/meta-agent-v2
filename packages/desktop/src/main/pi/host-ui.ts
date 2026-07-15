import { randomUUID } from "node:crypto";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionUiState, HostRequest, HostResponse } from "../../shared/contracts.ts";

interface PendingRequest {
	request: HostRequest;
	resolve(response: HostResponse): void;
	reject(error: Error): void;
	timer?: ReturnType<typeof setTimeout>;
}

const EMPTY_UI: ExtensionUiState = {
	statuses: {},
	workingVisible: true,
	toolsExpanded: false,
	widgets: [],
};

/** 将 Pi ExtensionUIContext 映射到 session 独立的 Desktop 请求与状态。 */
export class HostUi {
	private readonly pending = new Map<string, PendingRequest>();
	private state: ExtensionUiState = EMPTY_UI;
	private readonly changed: () => void;
	private readonly activeToolIds: () => string[];

	constructor(changed: () => void, activeToolIds: () => string[]) {
		this.changed = changed;
		this.activeToolIds = activeToolIds;
	}

	/** 返回当前尚未响应的交互请求。 */
	get requests(): HostRequest[] {
		return [...this.pending.values()].map(({ request }) => request);
	}

	/** 返回扩展维护的非阻塞工作台状态。 */
	get uiState(): ExtensionUiState {
		return this.state;
	}

	/** 创建供 Pi 扩展使用的 Desktop UI 上下文。 */
	createContext(): ExtensionUIContext {
		const host = this;
		const context: ExtensionUIContext = {
			select: (title: string, options: string[], opts?: ExtensionUIDialogOptions) =>
				this.ask("select", title, { options }, opts, (response) => response.value),
			confirm: (title: string, message: string, opts?: ExtensionUIDialogOptions) =>
				this.ask("confirm", title, { message }, opts, (response) => response.confirmed ?? false),
			input: (title: string, placeholder?: string, opts?: ExtensionUIDialogOptions) =>
				this.ask("input", title, { placeholder }, opts, (response) => response.value),
			editor: (title: string, prefill?: string) =>
				this.ask("editor", title, { message: prefill }, undefined, (response) => response.value),
			notify: (message: string, type?: "info" | "warning" | "error") => this.notify(message, type),
			onTerminalInput: () => this.unsupported("onTerminalInput"),
			setStatus: (key: string, text: string | undefined) => this.setStatus(key, text),
			setWorkingMessage: (message?: string) => this.patch({ workingMessage: message }),
			setWorkingVisible: (visible: boolean) => this.patch({ workingVisible: visible }),
			setWorkingIndicator: () => this.unsupported("setWorkingIndicator"),
			setHiddenThinkingLabel: (label?: string) => this.patch({ hiddenThinkingLabel: label }),
			setWidget: (key: string, content: unknown, options?: ExtensionWidgetOptions) =>
				this.setWidget(key, content, options),
			setFooter: () => this.unsupported("setFooter"),
			setHeader: () => this.unsupported("setHeader"),
			setTitle: (title: string) => this.patch({ windowTitle: title }),
			custom: () => this.unsupported("custom"),
			pasteToEditor: (text: string) => this.patch({ editorText: `${this.state.editorText ?? ""}${text}` }),
			setEditorText: (text: string) => this.patch({ editorText: text }),
			getEditorText: () => this.state.editorText ?? "",
			addAutocompleteProvider: () => this.unsupported("addAutocompleteProvider"),
			setEditorComponent: () => this.unsupported("setEditorComponent"),
			getEditorComponent: () => undefined,
			get theme() {
				return host.unsupported("theme");
			},
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "Desktop 不接受 TUI theme" }),
			getToolsExpanded: () => this.state.toolsExpanded,
			setToolsExpanded: (expanded: boolean) => this.patch({ toolsExpanded: expanded }),
		};
		return context;
	}

	/** 响应一个阻塞式扩展交互。 */
	respond(response: HostResponse): void {
		const item = this.pending.get(response.requestId);
		if (!item) throw new Error(`扩展 UI 请求不存在: ${response.requestId}`);
		this.pending.delete(response.requestId);
		if (item.timer) clearTimeout(item.timer);
		item.resolve(response);
		this.changed();
	}

	/** session 释放时拒绝所有尚未完成的交互。 */
	dispose(): void {
		for (const item of this.pending.values()) {
			if (item.timer) clearTimeout(item.timer);
			item.reject(new Error("Pi session 已关闭"));
		}
		this.pending.clear();
	}

	private ask<T>(
		type: HostRequest["type"],
		title: string,
		details: Partial<HostRequest>,
		opts: ExtensionUIDialogOptions | undefined,
		read: (response: HostResponse) => T,
	): Promise<T> {
		const id = randomUUID();
		const toolIds = this.activeToolIds();
		const request: HostRequest = {
			id,
			type,
			title,
			createdAt: Date.now(),
			toolCallId: toolIds.length === 1 ? toolIds[0] : undefined,
			...details,
		};
		return new Promise<T>((resolve, reject) => {
			const finish = (response: HostResponse) => resolve(read(response));
			const item: PendingRequest = { request, resolve: finish, reject };
			if (opts?.timeout) {
				item.timer = setTimeout(() => this.respond({ requestId: id, dismissed: true }), opts.timeout);
			}
			if (opts?.signal) {
				if (opts.signal.aborted) return reject(new Error("扩展 UI 请求已取消"));
				opts.signal.addEventListener("abort", () => this.cancel(id), { once: true });
			}
			this.pending.set(id, item);
			this.changed();
		});
	}

	private notify(message: string, notifyType?: "info" | "warning" | "error"): void {
		const id = randomUUID();
		this.pending.set(id, {
			request: { id, type: "notify", title: message, notifyType, createdAt: Date.now() },
			resolve: () => undefined,
			reject: () => undefined,
			timer: setTimeout(() => this.cancel(id), 6000),
		});
		this.changed();
	}

	private cancel(id: string): void {
		const item = this.pending.get(id);
		if (!item) return;
		this.pending.delete(id);
		if (item.timer) clearTimeout(item.timer);
		item.resolve({ requestId: id, dismissed: true });
		this.changed();
	}

	private setStatus(key: string, text: string | undefined): void {
		const statuses = { ...this.state.statuses };
		if (text === undefined) delete statuses[key];
		else statuses[key] = text;
		this.patch({ statuses });
	}

	private setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
		if (content !== undefined && (!Array.isArray(content) || !content.every((line) => typeof line === "string"))) {
			this.unsupported("setWidget(component)");
		}
		const widgets = this.state.widgets.filter((widget) => widget.key !== key);
		if (content) {
			widgets.push({
				key,
				lines: content as string[],
				placement: options?.placement === "aboveEditor" ? "aboveEditor" : "belowEditor",
			});
		}
		this.patch({ widgets });
	}

	private patch(value: Partial<ExtensionUiState>): void {
		this.state = { ...this.state, ...value };
		this.changed();
	}

	private unsupported(name: string): never {
		throw new Error(`Desktop 不支持 TUI 专用 ExtensionUIContext.${name}`);
	}
}
