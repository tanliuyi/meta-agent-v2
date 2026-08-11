import type { DesktopPlatform } from "../../../shared/desktop-api.ts";
import type { PreferencesKeyValueStore } from "./preferences-store.ts";
import { preferencesStorage } from "./preferences-store.ts";

export const KEYBOARD_SHORTCUTS_STORAGE_KEY = "keyboard-shortcuts";
export const KEYBOARD_SHORTCUTS_VERSION = 1;

export type ShortcutModifier = "mod" | "alt" | "shift";

export interface KeyboardShortcut {
  modifiers: ShortcutModifier[];
  key: string;
}

export interface KeyboardCommand {
  id: string;
  title: string;
  description: string;
  defaultBindings: readonly KeyboardShortcut[];
  allowInEditable: boolean;
}

export const KEYBOARD_COMMANDS = [
  {
    id: "task.new",
    title: "新建任务",
    description: "在当前项目中开始一个新任务",
    defaultBindings: [{ modifiers: ["mod"], key: "n" }],
    allowInEditable: false,
  },
  {
    id: "project.open",
    title: "打开项目",
    description: "添加一个本地项目",
    defaultBindings: [{ modifiers: ["mod"], key: "o" }],
    allowInEditable: false,
  },
  {
    id: "layout.sidebar.toggle",
    title: "切换侧边栏",
    description: "显示或隐藏侧边栏",
    defaultBindings: [{ modifiers: ["mod"], key: "b" }],
    allowInEditable: false,
  },
  {
    id: "app.settings.open",
    title: "设置",
    description: "打开 Meta Agent 设置",
    defaultBindings: [{ modifiers: ["mod"], key: "," }],
    allowInEditable: true,
  },
  {
    id: "app.shortcuts.open",
    title: "显示键盘快捷键",
    description: "打开键盘快捷键设置",
    defaultBindings: [{ modifiers: ["mod", "shift"], key: "/" }],
    allowInEditable: true,
  },
] as const satisfies readonly KeyboardCommand[];

export type KeyboardCommandId = (typeof KEYBOARD_COMMANDS)[number]["id"];
export type KeyboardShortcutOverrides = Partial<Record<KeyboardCommandId, KeyboardShortcut[] | null>>;

export interface KeyboardShortcutConfig {
  version: typeof KEYBOARD_SHORTCUTS_VERSION;
  bindings: KeyboardShortcutOverrides;
}

const COMMAND_IDS = new Set<string>(KEYBOARD_COMMANDS.map(({ id }) => id));
const MODIFIER_ORDER: readonly ShortcutModifier[] = ["mod", "alt", "shift"];
const SHIFTED_PUNCTUATION_KEYS = new Map([
  ["Backquote", "`"],
  ["Minus", "-"],
  ["Equal", "="],
  ["BracketLeft", "["],
  ["BracketRight", "]"],
  ["Backslash", "\\"],
  ["Semicolon", ";"],
  ["Quote", "'"],
  ["Comma", ","],
  ["Period", "."],
  ["Slash", "/"],
]);
const NAMED_KEYS = new Map([
  [" ", "Space"],
  ["esc", "Escape"],
  ["escape", "Escape"],
  ["enter", "Enter"],
  ["tab", "Tab"],
  ["backspace", "Backspace"],
  ["delete", "Delete"],
  ["arrowup", "ArrowUp"],
  ["arrowdown", "ArrowDown"],
  ["arrowleft", "ArrowLeft"],
  ["arrowright", "ArrowRight"],
  ["home", "Home"],
  ["end", "End"],
  ["pageup", "PageUp"],
  ["pagedown", "PageDown"],
]);

function normalizeKey(key: string): string | null {
  if (key === " ") return "Space";
  const trimmed = key.trim();
  if (!trimmed || ["control", "shift", "alt", "meta", "altgraph"].includes(trimmed.toLowerCase())) return null;
  if (trimmed.length === 1) return trimmed.toLowerCase();
  return NAMED_KEYS.get(trimmed.toLowerCase()) ?? (/^f(?:[1-9]|1[0-2])$/i.test(trimmed) ? trimmed.toUpperCase() : null);
}

export function normalizeKeyboardShortcut(value: unknown): KeyboardShortcut | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { modifiers?: unknown; key?: unknown };
  if (!Array.isArray(candidate.modifiers) || typeof candidate.key !== "string") return null;
  const modifiers = new Set<ShortcutModifier>();
  for (const modifier of candidate.modifiers) {
    if (modifier !== "mod" && modifier !== "alt" && modifier !== "shift") return null;
    modifiers.add(modifier);
  }
  const key = normalizeKey(candidate.key);
  return key ? { modifiers: MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key } : null;
}

export function keyboardShortcutKey(shortcut: KeyboardShortcut): string {
  return `${shortcut.modifiers.join("+")}::${shortcut.key.toLowerCase()}`;
}

export function keyboardShortcutFromEvent(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "repeat">,
  platform: DesktopPlatform,
): KeyboardShortcut | null {
  if (event.isComposing || event.repeat) return null;
  const key = normalizeKey(event.shiftKey ? (SHIFTED_PUNCTUATION_KEYS.get(event.code) ?? event.key) : event.key);
  if (!key) return null;
  const usesMod = platform === "darwin" ? event.metaKey : event.ctrlKey;
  if ((platform === "darwin" && event.ctrlKey) || (platform !== "darwin" && event.metaKey)) return null;
  return {
    modifiers: MODIFIER_ORDER.filter(
      (modifier) =>
        (modifier === "mod" && usesMod) ||
        (modifier === "alt" && event.altKey) ||
        (modifier === "shift" && event.shiftKey),
    ),
    key,
  };
}

export function isSafeKeyboardShortcut(shortcut: KeyboardShortcut): boolean {
  return (
    shortcut.modifiers.some((modifier) => modifier === "mod" || modifier === "alt") ||
    /^F(?:[1-9]|1[0-2])$/.test(shortcut.key)
  );
}

export function formatKeyboardShortcut(shortcut: KeyboardShortcut, platform: DesktopPlatform): string {
  const modifierLabels = shortcut.modifiers.map((modifier) => {
    if (modifier === "mod") return platform === "darwin" ? "⌘" : "Ctrl";
    if (modifier === "alt") return platform === "darwin" ? "⌥" : "Alt";
    return platform === "darwin" ? "⇧" : "Shift";
  });
  const keyLabel = shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key;
  return platform === "darwin" ? `${modifierLabels.join("")}${keyLabel}` : [...modifierLabels, keyLabel].join("+");
}

export function readKeyboardShortcutConfig(
  storage: PreferencesKeyValueStore = preferencesStorage,
): KeyboardShortcutConfig {
  const fallback: KeyboardShortcutConfig = { version: KEYBOARD_SHORTCUTS_VERSION, bindings: {} };
  const serialized = storage.getItem(KEYBOARD_SHORTCUTS_STORAGE_KEY);
  if (!serialized) return fallback;
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
    const candidate = parsed as { version?: unknown; bindings?: unknown };
    if (
      candidate.version !== KEYBOARD_SHORTCUTS_VERSION ||
      !candidate.bindings ||
      typeof candidate.bindings !== "object"
    ) {
      return fallback;
    }
    const bindings: KeyboardShortcutOverrides = {};
    for (const [commandId, value] of Object.entries(candidate.bindings)) {
      if (!COMMAND_IDS.has(commandId)) continue;
      if (value === null) {
        bindings[commandId as KeyboardCommandId] = null;
        continue;
      }
      if (!Array.isArray(value)) continue;
      const normalized = value.map(normalizeKeyboardShortcut);
      if (normalized.some((binding) => binding === null)) continue;
      const validBindings = normalized.filter(
        (binding): binding is KeyboardShortcut => binding !== null && isSafeKeyboardShortcut(binding),
      );
      if (validBindings.length !== normalized.length) continue;
      const unique = new Map(validBindings.map((binding) => [keyboardShortcutKey(binding), binding]));
      bindings[commandId as KeyboardCommandId] = [...unique.values()];
    }
    return { version: KEYBOARD_SHORTCUTS_VERSION, bindings: removeConflictingOverrides(bindings) };
  } catch {
    return fallback;
  }
}

function removeConflictingOverrides(bindings: KeyboardShortcutOverrides): KeyboardShortcutOverrides {
  const occupied = new Map<string, KeyboardCommandId>();
  for (const command of KEYBOARD_COMMANDS) {
    if (bindings[command.id] !== undefined) continue;
    for (const binding of command.defaultBindings) occupied.set(keyboardShortcutKey(binding), command.id);
  }
  const sanitized: KeyboardShortcutOverrides = {};
  for (const command of KEYBOARD_COMMANDS) {
    const override = bindings[command.id];
    if (override === undefined) continue;
    if (override === null) {
      sanitized[command.id] = null;
      continue;
    }
    const available = override.filter((binding) => !occupied.has(keyboardShortcutKey(binding)));
    sanitized[command.id] = available.length > 0 ? available : null;
    for (const binding of available) occupied.set(keyboardShortcutKey(binding), command.id);
  }
  return sanitized;
}

export function writeKeyboardShortcutConfig(
  bindings: KeyboardShortcutOverrides,
  storage: PreferencesKeyValueStore = preferencesStorage,
): void {
  const config: KeyboardShortcutConfig = { version: KEYBOARD_SHORTCUTS_VERSION, bindings };
  storage.setItem(KEYBOARD_SHORTCUTS_STORAGE_KEY, JSON.stringify(config));
}

export function effectiveKeyboardShortcuts(
  command: (typeof KEYBOARD_COMMANDS)[number],
  overrides: KeyboardShortcutOverrides,
): readonly KeyboardShortcut[] {
  const override = overrides[command.id];
  return override === undefined ? command.defaultBindings : (override ?? []);
}

export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}
