import { describe, expect, test, vi } from "vitest";
import {
  type BrowserContextMenuActions,
  buildBrowserContextMenuTemplate,
  isBrowserContextMenuHttpUrl,
} from "../src/main/browser/browser-context-menu.ts";

function createActions(): BrowserContextMenuActions {
  return {
    openUrlInNewTab: vi.fn(),
    downloadUrl: vi.fn(),
    copyText: vi.fn(),
    copyImage: vi.fn(),
    copyVideoFrame: vi.fn(),
    replaceMisspelling: vi.fn(),
    addWordToDictionary: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    cut: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    pasteAndMatchStyle: vi.fn(),
    delete: vi.fn(),
    selectAll: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    print: vi.fn(),
    inspect: vi.fn(),
    canGoBack: true,
    canGoForward: false,
  };
}

function createParams(): Electron.ContextMenuParams {
  return {
    x: 12,
    y: 24,
    frame: null,
    linkURL: "",
    linkText: "",
    pageURL: "https://example.com/",
    frameURL: "https://example.com/",
    srcURL: "",
    mediaType: "none",
    hasImageContents: false,
    isEditable: false,
    selectionText: "",
    titleText: "",
    altText: "",
    suggestedFilename: "",
    selectionRect: { x: 0, y: 0, width: 0, height: 0 },
    selectionStartOffset: 0,
    referrerPolicy: "default",
    misspelledWord: "",
    dictionarySuggestions: [],
    frameCharset: "UTF-8",
    formControlType: "none",
    spellcheckEnabled: false,
    menuSourceType: "mouse",
    mediaFlags: {
      inError: false,
      isPaused: true,
      isMuted: false,
      hasAudio: false,
      isLooping: false,
      isControlsVisible: false,
      canToggleControls: false,
      canPrint: false,
    },
    editFlags: {
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: false,
      canPaste: false,
      canDelete: false,
      canSelectAll: false,
      canEditRichly: false,
    },
  } as Electron.ContextMenuParams;
}

function labels(template: Electron.MenuItemConstructorOptions[]): string[] {
  return template.flatMap((item) => (item.type === "separator" || item.label === undefined ? [] : [item.label]));
}

function clickItem(template: Electron.MenuItemConstructorOptions[], label: string): void {
  const item = template.find((candidate) => candidate.label === label);
  expect(item).toBeDefined();
  item?.click?.({} as never, undefined, {} as never);
}

describe("browser Chromium context menu", () => {
  test("includes page navigation, save, print and inspect actions", () => {
    const actions = createActions();
    const template = buildBrowserContextMenuTemplate(createParams(), actions);

    expect(labels(template)).toEqual(["后退", "前进", "重新加载", "网页另存为...", "打印...", "检查"]);
    expect(template.find((item) => item.label === "后退")?.enabled).toBe(true);
    expect(template.find((item) => item.label === "前进")?.enabled).toBe(false);

    clickItem(template, "重新加载");
    clickItem(template, "打印...");
    clickItem(template, "检查");
    expect(actions.reload).toHaveBeenCalledOnce();
    expect(actions.print).toHaveBeenCalledOnce();
    expect(actions.inspect).toHaveBeenCalledWith(12, 24);
  });

  test("provides link and image actions, but excludes unsafe navigation URLs", () => {
    const actions = createActions();
    const params = createParams();
    params.linkURL = "https://example.com/file.zip";
    params.srcURL = "https://example.com/image.png";
    params.mediaType = "image";
    params.hasImageContents = true;

    const template = buildBrowserContextMenuTemplate(params, actions);
    expect(labels(template)).toEqual([
      "在新标签页中打开链接",
      "链接另存为...",
      "复制链接地址",
      "在新标签页中打开图片",
      "图片另存为...",
      "复制图片",
      "复制图片地址",
      "后退",
      "前进",
      "重新加载",
      "网页另存为...",
      "打印...",
      "检查",
    ]);

    clickItem(template, "在新标签页中打开链接");
    clickItem(template, "链接另存为...");
    clickItem(template, "复制图片");
    expect(actions.openUrlInNewTab).toHaveBeenCalledWith("https://example.com/file.zip");
    expect(actions.downloadUrl).toHaveBeenCalledWith("https://example.com/file.zip");
    expect(actions.copyImage).toHaveBeenCalledWith(12, 24);

    params.linkURL = "javascript:alert(1)";
    const unsafeTemplate = buildBrowserContextMenuTemplate(params, actions);
    expect(labels(unsafeTemplate)).not.toContain("在新标签页中打开链接");
    expect(labels(unsafeTemplate)).not.toContain("链接另存为...");
    expect(labels(unsafeTemplate)).toContain("复制链接地址");
  });

  test("provides spelling and editable commands with renderer-provided capabilities", () => {
    const actions = createActions();
    const params = createParams();
    params.isEditable = true;
    params.misspelledWord = "teh";
    params.dictionarySuggestions = ["the"];
    params.editFlags = {
      canUndo: true,
      canRedo: false,
      canCut: true,
      canCopy: true,
      canPaste: true,
      canDelete: true,
      canSelectAll: true,
      canEditRichly: true,
    };

    const template = buildBrowserContextMenuTemplate(params, actions);
    expect(labels(template)).toContain("使用“the”");
    expect(labels(template)).toContain("将“teh”添加到词典");
    expect(labels(template)).toContain("粘贴并匹配样式");
    expect(template.find((item) => item.label === "撤销")?.enabled).toBe(true);
    expect(template.find((item) => item.label === "重做")?.enabled).toBe(false);

    clickItem(template, "使用“the”");
    clickItem(template, "将“teh”添加到词典");
    clickItem(template, "剪切");
    clickItem(template, "粘贴并匹配样式");
    expect(actions.replaceMisspelling).toHaveBeenCalledWith("the");
    expect(actions.addWordToDictionary).toHaveBeenCalledWith("teh");
    expect(actions.cut).toHaveBeenCalledOnce();
    expect(actions.pasteAndMatchStyle).toHaveBeenCalledOnce();
  });

  test("accepts only HTTP(S) URLs for browser navigation and downloads", () => {
    expect(isBrowserContextMenuHttpUrl("https://example.com/path")).toBe(true);
    expect(isBrowserContextMenuHttpUrl("http://localhost:3000/")).toBe(true);
    expect(isBrowserContextMenuHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isBrowserContextMenuHttpUrl("file:///tmp/page.html")).toBe(false);
    expect(isBrowserContextMenuHttpUrl("not a url")).toBe(false);
  });
});
