import { describe, expect, it } from "vitest";
import {
  effectiveKeyboardShortcuts,
  formatKeyboardShortcut,
  isSafeKeyboardShortcut,
  KEYBOARD_COMMANDS,
  KEYBOARD_SHORTCUTS_STORAGE_KEY,
  keyboardShortcutFromEvent,
  keyboardShortcutKey,
  readKeyboardShortcutConfig,
  writeKeyboardShortcutConfig,
} from "../src/renderer/src/state/keyboard-shortcuts.ts";
import type { PreferencesKeyValueStore } from "../src/renderer/src/state/preferences-store.ts";

function memoryStorage(initial: string | null = null): PreferencesKeyValueStore {
  let value = initial;
  return {
    getItem: (key) => (key === KEYBOARD_SHORTCUTS_STORAGE_KEY ? value : null),
    setItem: (key, next) => {
      if (key === KEYBOARD_SHORTCUTS_STORAGE_KEY) value = next;
    },
    reset: () => {
      value = null;
    },
  };
}

function keyEvent(
  overrides: Partial<KeyboardEvent> = {},
): Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "repeat"> {
  return {
    key: "b",
    code: "KeyB",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    repeat: false,
    ...overrides,
  };
}

describe("keyboard shortcuts", () => {
  it("读取严格版本的 JSON，并忽略未知命令和非法绑定", () => {
    const storage = memoryStorage(
      JSON.stringify({
        version: 1,
        bindings: {
          "layout.sidebar.toggle": [{ modifiers: ["shift", "mod", "shift"], key: "B" }],
          "task.new": null,
          "unknown.command": [{ modifiers: ["mod"], key: "x" }],
          "project.open": [{ modifiers: ["control"], key: "o" }],
          "app.settings.open": [{ modifiers: [], key: "x" }],
        },
      }),
    );

    expect(readKeyboardShortcutConfig(storage)).toEqual({
      version: 1,
      bindings: {
        "layout.sidebar.toggle": [{ modifiers: ["mod", "shift"], key: "b" }],
        "task.new": null,
      },
    });
  });

  it("损坏或版本不匹配的 JSON 回退到默认配置", () => {
    expect(readKeyboardShortcutConfig(memoryStorage("{"))).toEqual({ version: 1, bindings: {} });
    expect(readKeyboardShortcutConfig(memoryStorage('{"version":2,"bindings":{}}'))).toEqual({
      version: 1,
      bindings: {},
    });
  });

  it("写入版本化 JSON，覆盖和禁用语义可被还原", () => {
    const storage = memoryStorage();
    writeKeyboardShortcutConfig(
      {
        "task.new": null,
        "project.open": [{ modifiers: ["mod", "alt"], key: "o" }],
      },
      storage,
    );

    const config = readKeyboardShortcutConfig(storage);
    expect(config.bindings["task.new"]).toBeNull();
    expect(config.bindings["project.open"]).toEqual([{ modifiers: ["mod", "alt"], key: "o" }]);
    expect(effectiveKeyboardShortcuts(KEYBOARD_COMMANDS[0], config.bindings)).toEqual([]);
  });

  it("按平台把主修饰键规范化并拒绝重复、输入法和跨平台修饰键", () => {
    expect(keyboardShortcutFromEvent(keyEvent({ ctrlKey: true }), "win32")).toEqual({ modifiers: ["mod"], key: "b" });
    expect(keyboardShortcutFromEvent(keyEvent({ metaKey: true, shiftKey: true }), "darwin")).toEqual({
      modifiers: ["mod", "shift"],
      key: "b",
    });
    expect(keyboardShortcutFromEvent(keyEvent({ metaKey: true }), "win32")).toBeNull();
    expect(keyboardShortcutFromEvent(keyEvent({ ctrlKey: true, isComposing: true }), "win32")).toBeNull();
    expect(keyboardShortcutFromEvent(keyEvent({ ctrlKey: true, repeat: true }), "win32")).toBeNull();
    expect(
      keyboardShortcutFromEvent(keyEvent({ key: "?", code: "Slash", ctrlKey: true, shiftKey: true }), "win32"),
    ).toEqual({ modifiers: ["mod", "shift"], key: "/" });
    expect(isSafeKeyboardShortcut({ modifiers: [], key: "x" })).toBe(false);
    expect(isSafeKeyboardShortcut({ modifiers: ["shift"], key: "a" })).toBe(false);
    expect(isSafeKeyboardShortcut({ modifiers: ["alt"], key: "a" })).toBe(true);
    expect(isSafeKeyboardShortcut({ modifiers: [], key: "F2" })).toBe(true);
  });

  it("读取 JSON 时移除与其他命令默认键冲突的覆盖", () => {
    const config = readKeyboardShortcutConfig(
      memoryStorage(
        JSON.stringify({
          version: 1,
          bindings: {
            "task.new": [{ modifiers: ["mod"], key: "o" }],
          },
        }),
      ),
    );

    expect(config.bindings["task.new"]).toBeNull();
    expect(effectiveKeyboardShortcuts(KEYBOARD_COMMANDS[1], config.bindings)).toEqual([
      { modifiers: ["mod"], key: "o" },
    ]);
  });

  it("允许覆盖后的命令复用另一个命令释放的默认键", () => {
    const config = readKeyboardShortcutConfig(
      memoryStorage(
        JSON.stringify({
          version: 1,
          bindings: {
            "task.new": [{ modifiers: ["mod"], key: "o" }],
            "project.open": [{ modifiers: ["mod"], key: "p" }],
          },
        }),
      ),
    );

    expect(config.bindings).toEqual({
      "task.new": [{ modifiers: ["mod"], key: "o" }],
      "project.open": [{ modifiers: ["mod"], key: "p" }],
    });
  });

  it("冲突键和平台显示保持稳定", () => {
    const shortcut = { modifiers: ["mod", "alt", "shift"] as const, key: "/" };
    expect(keyboardShortcutKey({ modifiers: [...shortcut.modifiers], key: shortcut.key })).toBe("mod+alt+shift::/");
    expect(formatKeyboardShortcut({ modifiers: [...shortcut.modifiers], key: shortcut.key }, "win32")).toBe(
      "Ctrl+Alt+Shift+/",
    );
    expect(formatKeyboardShortcut({ modifiers: [...shortcut.modifiers], key: shortcut.key }, "darwin")).toBe("⌘⌥⇧/");
  });
});
