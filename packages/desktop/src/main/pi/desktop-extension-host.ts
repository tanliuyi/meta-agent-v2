import { randomUUID } from "node:crypto";
import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionUINotificationOptions,
  ExtensionWidgetOptions,
} from "@earendil-works/pi-coding-agent";
import type { DesktopExtensionHostState, HostRequest, HostResponse } from "../../shared/contracts.ts";
import type { DesktopWidgetViewport } from "../../shared/desktop-extension-contracts.ts";
import {
  type QuestionnaireUI,
  readQuestionnaireResult,
  validateQuestionnaireInput,
} from "../../shared/questionnaire-contracts.ts";
import { DesktopWidgetAdapter } from "./desktop-widget-adapter.ts";

interface PendingRequest {
  request: HostRequest;
  resolve(response: HostResponse): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
}

const EMPTY_HOST_STATE: DesktopExtensionHostState = { statuses: {}, widgets: [] };

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

/**
 * Declarative Desktop Host Profile v1 for controlled Pi extensions.
 *
 * Unsupported display-only surfaces degrade to a warning plus a defined no-op
 * so extension tool chains are not interrupted. Session-changing actions
 * (`session.reload`, `session.replace`) and dialogs on a disposed host keep
 * failing with a stable error instead.
 */
export class DesktopExtensionHost {
  private readonly pending = new Map<string, PendingRequest>();
  private state: DesktopExtensionHostState = EMPTY_HOST_STATE;
  private readonly hostId = randomUUID();
  private readonly widgetAdapter: DesktopWidgetAdapter;
  private composerRevision = 0;
  private disposed = false;
  private readonly changed: () => void;
  private readonly activeToolIds: () => string[];
  private readonly publishNotification: (
    message: string,
    type: "info" | "warning" | "error",
    options?: ExtensionUINotificationOptions,
  ) => void;
  private readonly warn: (message: string) => void;

  constructor(
    changed: () => void,
    activeToolIds: () => string[],
    publishNotification: (
      message: string,
      type: "info" | "warning" | "error",
      options?: ExtensionUINotificationOptions,
    ) => void = () => undefined,
    warn: (message: string) => void = () => undefined,
  ) {
    this.changed = changed;
    this.activeToolIds = activeToolIds;
    this.publishNotification = publishNotification;
    this.warn = warn;
    this.widgetAdapter = new DesktopWidgetAdapter(
      this.hostId,
      (widget) => {
        const widgets = this.state.widgets.filter((current) => current.key !== widget.key);
        this.patch("ui.widget.text", { widgets: [...widgets, widget] });
      },
      warn,
    );
  }

  get requests(): HostRequest[] {
    return [...this.pending.values()].map(({ request }) => request);
  }

  get hostState(): DesktopExtensionHostState {
    return this.state;
  }

  createContext(): ExtensionUIContext & QuestionnaireUI & { widgetCapabilities: { components: true; input: false } } {
    const host = this;
    return {
      widgetCapabilities: { components: true, input: false },
      questionnaire: (input, opts) => {
        validateQuestionnaireInput(input);
        return this.ask(
          "questionnaire",
          "Questionnaire",
          { questionnaire: structuredClone(input) },
          opts,
          (response) => response.questionnaire ?? { answers: [], cancelled: true },
        );
      },
      select: (title: string, options: string[], opts?: ExtensionUIDialogOptions) =>
        this.ask("select", title, { options }, opts, (response) => response.value),
      confirm: (title: string, message: string, opts?: ExtensionUIDialogOptions) =>
        this.ask("confirm", title, { message }, opts, (response) => response.confirmed ?? false),
      input: (title: string, placeholder?: string, opts?: ExtensionUIDialogOptions) =>
        this.ask("input", title, { placeholder }, opts, (response) => response.value),
      editor: (title: string, prefill?: string) =>
        this.ask("editor", title, { message: prefill }, undefined, (response) => response.value),
      notify: (message: string, type?: "info" | "warning" | "error", options?: ExtensionUINotificationOptions) =>
        this.notify(message, type, options),
      onTerminalInput: () => {
        this.degrade("ui.terminal.input");
        return () => undefined;
      },
      setStatus: (key: string, text: string | undefined) => this.setStatus(key, text),
      setWorkingMessage: (message?: string) =>
        this.patch("ui.working", {
          working: { ...this.state.working, message, visible: this.state.working?.visible ?? true },
        }),
      setWorkingVisible: (visible: boolean) =>
        this.patch("ui.working", { working: { ...this.state.working, visible } }),
      setWorkingIndicator: () => this.degrade("ui.working", "working indicator frames are not supported"),
      setHiddenThinkingLabel: () => this.degrade("ui.working", "hidden thinking labels are not supported"),
      setWidget: (key: string, content: unknown, options?: ExtensionWidgetOptions) =>
        this.setWidget(key, content, options),
      setFooter: () => this.degrade("ui.tui.chrome", "custom footer components are not supported"),
      setHeader: () => this.degrade("ui.tui.chrome", "custom header components are not supported"),
      setTitle: (title: string) => this.patch("ui.title", { windowTitle: title }),
      custom: async <T>() => {
        this.degrade("ui.tui.custom");
        return undefined as T;
      },
      pasteToEditor: (text: string) => this.sendComposerCommand("append", text),
      setEditorText: (text: string) => this.sendComposerCommand("replace", text),
      getEditorText: () => {
        this.degrade("ui.composer.read");
        return undefined as unknown as string;
      },
      addAutocompleteProvider: () => this.degrade("ui.tui.editor", "autocomplete providers are not supported"),
      setEditorComponent: () => this.degrade("ui.tui.editor", "custom editor components are not supported"),
      getEditorComponent: () => {
        this.degrade("ui.tui.editor", "custom editor components are not supported");
        return undefined;
      },
      get theme() {
        return host.widgetAdapter.theme;
      },
      getAllThemes: () => {
        this.degrade("ui.tui.theme");
        return [];
      },
      getTheme: () => {
        this.degrade("ui.tui.theme");
        return undefined;
      },
      setTheme: () => {
        this.degrade("ui.tui.theme", "themes are not supported");
        return { success: false, error: "Desktop does not support extension themes" };
      },
      getToolsExpanded: () => {
        this.degrade("ui.tui.chrome");
        return false;
      },
      setToolsExpanded: () => this.degrade("ui.tui.chrome"),
    };
  }

  respond(response: HostResponse): void {
    this.assertActive("ui.dialog");
    const item = this.pending.get(response.requestId);
    if (!item) throw new Error(`Extension UI request does not exist: ${response.requestId}`);
    if (item.request.questionnaire) {
      response = {
        ...response,
        questionnaire: readQuestionnaireResult(
          item.request.questionnaire,
          response.dismissed ? { answers: [], cancelled: true } : response.questionnaire,
        ),
      };
    }
    this.pending.delete(response.requestId);
    if (item.timer) clearTimeout(item.timer);
    item.removeAbortListener?.();
    item.resolve(response);
    this.changed();
  }

  reset(): void {
    this.assertActive("ui.dialog");
    const error = new Error("Desktop extension host request became stale after reload");
    for (const item of this.pending.values()) {
      if (item.timer) clearTimeout(item.timer);
      item.removeAbortListener?.();
      item.reject(error);
    }
    this.pending.clear();
    this.widgetAdapter.clear();
    this.state = EMPTY_HOST_STATE;
    this.changed();
  }

  dispose(): void {
    if (this.disposed) return;
    this.widgetAdapter.clear();
    this.disposed = true;
    const error = new DesktopExtensionCompatibilityError("DESKTOP_EXTENSION_HOST_DISPOSED", "ui.dialog");
    for (const item of this.pending.values()) {
      if (item.timer) clearTimeout(item.timer);
      item.removeAbortListener?.();
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
      if (opts?.signal) {
        if (opts.signal.aborted) {
          reject(new DOMException("Extension UI request aborted", "AbortError"));
          return;
        }
        const signal = opts.signal;
        const abort = () => this.cancel(id);
        signal.addEventListener("abort", abort, { once: true });
        item.removeAbortListener = () => signal.removeEventListener("abort", abort);
      }
      if (opts?.timeout) item.timer = setTimeout(() => this.cancel(id), opts.timeout);
      this.pending.set(id, item);
      this.changed();
    });
  }

  private notify(message: string, type?: "info" | "warning" | "error", options?: ExtensionUINotificationOptions): void {
    this.assertActive("ui.notify");
    if (options) this.publishNotification(message, type ?? "info", options);
    else this.publishNotification(message, type ?? "info");
  }

  private cancel(id: string): void {
    const item = this.pending.get(id);
    if (!item) return;
    this.pending.delete(id);
    if (item.timer) clearTimeout(item.timer);
    item.removeAbortListener?.();
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

  configureWidget(viewport: DesktopWidgetViewport): void {
    this.assertActive("ui.widget.text");
    this.widgetAdapter.configure(viewport);
  }

  private setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
    this.assertActive("ui.widget.text");
    if (typeof content === "function") {
      this.widgetAdapter.set(
        key,
        content as Exclude<Parameters<ExtensionUIContext["setWidget"]>[1], undefined>,
        options,
      );
      return;
    }
    if (content !== undefined && (!Array.isArray(content) || !content.every((line) => typeof line === "string"))) {
      this.degrade("ui.widget.text", "widget content must be lines or a component factory");
      return;
    }
    this.widgetAdapter.remove(key);
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

  private degrade(capability: string, detail?: string): void {
    this.assertActive(capability);
    this.warn(
      `Desktop extension capability ${capability} is unsupported and was ignored${detail ? ` (${detail})` : ""}`,
    );
  }
}
