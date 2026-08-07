import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

/** Native context-menu actions supplied by BrowserManager for one guest webContents. */
export interface BrowserContextMenuActions {
  openUrlInNewTab(url: string): void;
  downloadUrl(url: string): void;
  copyText(text: string): void;
  copyImage(x: number, y: number): void;
  copyVideoFrame(x: number, y: number): void;
  replaceMisspelling(word: string): void;
  addWordToDictionary(word: string): void;
  undo(): void;
  redo(): void;
  cut(): void;
  copy(): void;
  paste(): void;
  pasteAndMatchStyle(): void;
  delete(): void;
  selectAll(): void;
  goBack(): void;
  goForward(): void;
  reload(): void;
  print(): void;
  inspect(x: number, y: number): void;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** Build the Chromium-style menu for one guest page without opening it. */
export function buildBrowserContextMenuTemplate(
  params: ContextMenuParams,
  actions: BrowserContextMenuActions,
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  const editFlags = params.editFlags ?? emptyEditFlags();
  const linkUrl = params.linkURL.trim();
  const sourceUrl = params.srcURL.trim();
  const selectionText = params.selectionText.trim();
  const pageUrl = params.pageURL.trim();
  const safeLinkUrl = isHttpUrl(linkUrl);
  const safeSourceUrl = isHttpUrl(sourceUrl);

  if (linkUrl.length > 0) {
    if (safeLinkUrl) {
      items.push({ label: "在新标签页中打开链接", click: () => actions.openUrlInNewTab(linkUrl) });
      items.push({ label: "链接另存为...", click: () => actions.downloadUrl(linkUrl) });
    }
    items.push({ label: "复制链接地址", click: () => actions.copyText(linkUrl) });
    appendSeparator(items);
  }

  if (params.mediaType === "image" && sourceUrl.length > 0) {
    if (safeSourceUrl) {
      items.push({ label: "在新标签页中打开图片", click: () => actions.openUrlInNewTab(sourceUrl) });
      items.push({ label: "图片另存为...", click: () => actions.downloadUrl(sourceUrl) });
    }
    if (params.hasImageContents) items.push({ label: "复制图片", click: () => actions.copyImage(params.x, params.y) });
    items.push({ label: "复制图片地址", click: () => actions.copyText(sourceUrl) });
    appendSeparator(items);
  } else if ((params.mediaType === "audio" || params.mediaType === "video") && sourceUrl.length > 0) {
    if (safeSourceUrl) {
      items.push({ label: "在新标签页中打开媒体", click: () => actions.openUrlInNewTab(sourceUrl) });
      items.push({ label: "媒体另存为...", click: () => actions.downloadUrl(sourceUrl) });
    }
    if (params.mediaType === "video") {
      items.push({ label: "复制视频帧", click: () => actions.copyVideoFrame(params.x, params.y) });
    }
    items.push({ label: "复制媒体地址", click: () => actions.copyText(sourceUrl) });
    appendSeparator(items);
  }

  if (!params.isEditable && selectionText.length > 0 && editFlags.canCopy) {
    items.push({ label: "复制", click: () => actions.copy() });
    appendSeparator(items);
  }

  const misspelledWord = params.misspelledWord.trim();
  if (params.isEditable && misspelledWord.length > 0) {
    for (const suggestion of params.dictionarySuggestions ?? []) {
      const word = suggestion.trim();
      if (word.length === 0) continue;
      items.push({ label: `使用“${truncateMenuText(word)}”`, click: () => actions.replaceMisspelling(word) });
    }
    items.push({
      label: `将“${truncateMenuText(misspelledWord)}”添加到词典`,
      click: () => actions.addWordToDictionary(misspelledWord),
    });
    appendSeparator(items);
  }

  if (params.isEditable) {
    items.push({ label: "撤销", enabled: editFlags.canUndo, click: () => actions.undo() });
    items.push({ label: "重做", enabled: editFlags.canRedo, click: () => actions.redo() });
    appendSeparator(items);
    items.push({ label: "剪切", enabled: editFlags.canCut, click: () => actions.cut() });
    items.push({ label: "复制", enabled: editFlags.canCopy, click: () => actions.copy() });
    items.push({ label: "粘贴", enabled: editFlags.canPaste, click: () => actions.paste() });
    items.push({
      label: "粘贴并匹配样式",
      enabled: editFlags.canPaste && editFlags.canEditRichly,
      click: () => actions.pasteAndMatchStyle(),
    });
    appendSeparator(items);
    items.push({ label: "删除", enabled: editFlags.canDelete, click: () => actions.delete() });
    items.push({ label: "全选", enabled: editFlags.canSelectAll, click: () => actions.selectAll() });
    appendSeparator(items);
  }

  items.push({ label: "后退", enabled: actions.canGoBack, click: () => actions.goBack() });
  items.push({ label: "前进", enabled: actions.canGoForward, click: () => actions.goForward() });
  items.push({ label: "重新加载", click: () => actions.reload() });
  appendSeparator(items);
  if (isHttpUrl(pageUrl)) items.push({ label: "网页另存为...", click: () => actions.downloadUrl(pageUrl) });
  items.push({ label: "打印...", click: () => actions.print() });
  items.push({ label: "检查", click: () => actions.inspect(params.x, params.y) });

  removeTrailingSeparator(items);
  return items;
}

/** Only browser navigations and downloads from the context menu may use HTTP(S). */
export function isBrowserContextMenuHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function appendSeparator(items: MenuItemConstructorOptions[]): void {
  if (items.length === 0 || items[items.length - 1]?.type === "separator") return;
  items.push({ type: "separator" });
}

function removeTrailingSeparator(items: MenuItemConstructorOptions[]): void {
  if (items[items.length - 1]?.type === "separator") items.pop();
}

function truncateMenuText(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}...` : text;
}

function emptyEditFlags(): Electron.EditFlags {
  return {
    canUndo: false,
    canRedo: false,
    canCut: false,
    canCopy: false,
    canPaste: false,
    canDelete: false,
    canSelectAll: false,
    canEditRichly: false,
  };
}

function isHttpUrl(raw: string): boolean {
  return raw.length > 0 && isBrowserContextMenuHttpUrl(raw);
}
