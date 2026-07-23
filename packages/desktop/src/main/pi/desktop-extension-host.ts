import { randomUUID } from "node:crypto";
import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionWidgetOptions,
} from "@earendil-works/pi-coding-agent";
import type { DesktopExtensionHostState, HostRequest, HostResponse } from "../../shared/contracts.ts";

interface PendingRequest {
  request: HostRequest;
  resolve(response: HostResponse): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

const EMPTY_HOST_STATE: DesktopExtensionHostState = {
  statuses: {},
  widgets: [],
};

export class DesktopExtensionCompatibilityError extends Error {
  readonly code: "DESKTOP_EXTENSION_CAPABILITY_UNAVAILABLE" | "DESKTOP_EXTENSION_HOST_DISPOSED";
  readonly capability: string;

  constructor(
    code: "DESKTOP_EXTENSION_CAPABILITY_UNAVAILABLE" | "DESKTOP_EXTENSION_HOST_DISPOSED",
    capability: string,
  ) {
    super(
      code === "DESKTOP_EXTENSION_HOST_DISPOSED"
        ? `Desktop extension host is disposed: ${capability}`
        : `Desktop extension capability is unavailable: ${capability}`,
    );
    this.name = "DesktopExtensionCompatibilityError";
    this.code = code;
    this.capability = capability;
  }
}

/** Declarative Desktop Host Profile v1 for controlled Pi extensions. */
export class DesktopExtensionHost {
  private readonly pending = new Map<string, PendingRequest>();
  private state: DesktopExtensionHostState = EMPTY_HOST_STATE;
  private readonly hostId = randomUUID();
  private composerRevision = 0;
  private disposed = false;
  private readonly changed: () => void;
  private readonly activeToolIds: () => string[];
  private readonly publishNotification: (message: string, type: "info" | "warning" | "error") => void;

  constructor(
    changed: () => void,
    activeToolIds: () => string[],
    publishNotification: (message: string, type: "info" | "warning" | "error") => void = () => undefined,
  ) {
    this.changed = changed;
    this.activeToolIds = activeToolIds;
    this.publishNotification = publishNotification;
  }

  get requests(): HostRequest[] {
    return [...this.pending.values()].map(({ request }) => request);
  }

  get hostState(): DesktopExtensionHostState {
    return this.state;
  }

  createContext(): ExtensionUIContext {
    const host = this;
    return {
      select: (title: string, options: string[], opts?: ExtensionUIDialogOptions) =>
        this.ask("select", title, { options }, opts, (response) => response.value),
      confirm: (title: string, message: string, opts?: ExtensionUIDialogOptions) =>
        this.ask("confirm", title, { message }, opts, (response) => response.confirmed ?? false),
      input: (title: string, placeholder?: string, opts?: ExtensionUIDialogOptions) =>
        this.ask("input", title, { placeholder }, opts, (response) => response.value),
      editor: (title: string, prefill?: string) =>
        this.ask("editor", title, { message: prefill }, undefined, (response) => response.value),
      notify: (message: string, type?: "info" | "warning" | "error") => this.notify(message, type),
      onTerminalInput: () => this.unavailable("ui.terminal.input"),
      setStatus: (key: string, text: string | undefined) => this.setStatus(key, text),
      setWorkingMessage: () => this.unavailable("ui.working"),
      setWorkingVisible: () => this.unavailable("ui.working"),
      setWorkingIndicator: () => this.unavailable("ui.working"),
      setHiddenThinkingLabel: () => this.unavailable("ui.working"),
      setWidget: (key: string, content: unknown, options?: ExtensionWidgetOptions) =>
        this.setWidget(key, content, options),
      setFooter: () => this.unavailable("ui.tui.chrome"),
      setHeader: () => this.unavailable("ui.tui.chrome"),
      setTitle: (title: string) => this.patch("ui.title", { windowTitle: title }),
      custom: async <T>() => this.unavailable<T>("ui.tui.custom"),
      pasteToEditor: (text: string) => this.sendComposerCommand("append", text),
      setEditorText: (text: string) => this.sendComposerCommand("replace", text),
      getEditorText: () => this.unavailable<string>("ui.composer.read"),
      addAutocompleteProvider: () => this.unavailable("ui.tui.editor"),
      setEditorComponent: () => this.unavailable("ui.tui.editor"),
      getEditorComponent: () => this.unavailable("ui.tui.editor"),
      get theme() {
        return host.unavailable<ExtensionUIContext["theme"]>("ui.tui.theme");
      },
      getAllThemes: () => this.unavailable("ui.tui.theme"),
      getTheme: () => this.unavailable("ui.tui.theme"),
      setTheme: () => this.unavailable("ui.tui.theme"),
      getToolsExpanded: () => this.unavailable<boolean>("ui.tui.chrome"),
      setToolsExpanded: () => this.unavailable("ui.tui.chrome"),
    };
  }

  respond(response: HostResponse): void {
    this.assertActive("ui.dialog");
    const item = this.pending.get(response.requestId);
    if (!item) throw new Error(`Extension UI request does not exist: ${response.requestId}`);
    this.pending.delete(response.requestId);
    if (item.timer) clearTimeout(item.timer);
    item.resolve(response);
    this.changed();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new DesktopExtensionCompatibilityError("DESKTOP_EXTENSION_HOST_DISPOSED", "ui.dialog");
    for (const item of this.pending.values()) {
      if (item.timer) clearTimeout(item.timer);
      item.reject(error);
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
    this.assertActive("ui.dialog");
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
      const item: PendingRequest = { request, resolve: (response) => resolve(read(response)), reject };
      if (opts?.timeout) {
        item.timer = setTimeout(() => this.cancel(id), opts.timeout);
      }
      if (opts?.signal) {
        if (opts.signal.aborted) {
          reject(new DOMException("Extension UI request aborted", "AbortError"));
          return;
        }
        opts.signal.addEventListener("abort", () => this.cancel(id), { once: true });
      }
      this.pending.set(id, item);
      this.changed();
    });
  }

  private notify(message: string, type?: "info" | "warning" | "error"): void {
    this.assertActive("ui.notify");
    this.publishNotification(message, type ?? "info");
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
    this.assertActive("ui.status");
    const statuses = { ...this.state.statuses };
    if (text === undefined) delete statuses[key];
    else statuses[key] = text;
    this.patch("ui.status", { statuses });
  }

  private sendComposerCommand(mode: "replace" | "append", text: string): void {
    this.composerRevision += 1;
    this.patch("ui.composer.write", {
      composerCommand: { hostId: this.hostId, revision: this.composerRevision, mode, text },
    });
  }

  private setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
    this.assertActive("ui.widget.text");
    if (content !== undefined && (!Array.isArray(content) || !content.every((line) => typeof line === "string"))) {
      this.unavailable("ui.tui.custom");
    }
    const widgets = this.state.widgets.filter((widget) => widget.key !== key);
    if (content) {
      widgets.push({
        key,
        lines: content as string[],
        placement: options?.placement === "aboveEditor" ? "aboveEditor" : "belowEditor",
      });
    }
    this.patch("ui.widget.text", { widgets });
  }

  private patch(capability: string, value: Partial<DesktopExtensionHostState>): void {
    this.assertActive(capability);
    this.state = { ...this.state, ...value };
    this.changed();
  }

  private assertActive(capability: string): void {
    if (this.disposed) {
      throw new DesktopExtensionCompatibilityError("DESKTOP_EXTENSION_HOST_DISPOSED", capability);
    }
  }

  private unavailable<T = never>(capability: string): T {
    this.assertActive(capability);
    throw new DesktopExtensionCompatibilityError("DESKTOP_EXTENSION_CAPABILITY_UNAVAILABLE", capability);
  }
}
