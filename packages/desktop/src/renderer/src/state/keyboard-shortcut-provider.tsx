import { useMatchRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useDesktopActions, useDesktopSelector } from "./desktop-context.tsx";
import {
  effectiveKeyboardShortcuts,
  isEditableKeyboardTarget,
  KEYBOARD_COMMANDS,
  type KeyboardCommandId,
  type KeyboardShortcut,
  type KeyboardShortcutOverrides,
  keyboardShortcutFromEvent,
  keyboardShortcutKey,
  readKeyboardShortcutConfig,
  writeKeyboardShortcutConfig,
} from "./keyboard-shortcuts.ts";
import { useLayout } from "./layout.tsx";
import { draftSearch } from "./session-navigation.ts";
import { validateSettingsSearch } from "./settings-navigation.ts";

interface KeyboardShortcutContextValue {
  commands: typeof KEYBOARD_COMMANDS;
  bindings: KeyboardShortcutOverrides;
  getBindings(commandId: KeyboardCommandId): readonly KeyboardShortcut[];
  setBindings(commandId: KeyboardCommandId, bindings: KeyboardShortcut[] | null): void;
  resetAll(): void;
}

const KeyboardShortcutContext = createContext<KeyboardShortcutContextValue | null>(null);

export function KeyboardShortcutProvider({ children }: { children: ReactNode }) {
  const [bindings, setBindingsState] = useState(() => readKeyboardShortcutConfig().bindings);
  const activeProjectId = useDesktopSelector((state) => state.activeProjectId);
  const actions = useDesktopActions();
  const { toggleSidebar } = useLayout();
  const matchRoute = useMatchRoute();
  const navigate = useNavigate();
  const routeSearch = useSearch({ strict: false });

  const getBindings = useCallback(
    (commandId: KeyboardCommandId) => {
      const command = KEYBOARD_COMMANDS.find(({ id }) => id === commandId);
      return command ? effectiveKeyboardShortcuts(command, bindings) : [];
    },
    [bindings],
  );

  const setBindings = useCallback((commandId: KeyboardCommandId, nextBindings: KeyboardShortcut[] | null) => {
    setBindingsState((current) => {
      const next = { ...current, [commandId]: nextBindings };
      writeKeyboardShortcutConfig(next);
      return next;
    });
  }, []);

  const resetAll = useCallback(() => {
    setBindingsState({});
    writeKeyboardShortcutConfig({});
  }, []);

  const execute = useCallback(
    (commandId: KeyboardCommandId) => {
      const sessionRoute = matchRoute({ to: "/projects/$projectId/session/$threadId", fuzzy: false });
      const settingsSearch = sessionRoute
        ? { returnProjectId: sessionRoute.projectId, returnThreadId: sessionRoute.threadId }
        : validateSettingsSearch(routeSearch);
      switch (commandId) {
        case "task.new":
          void navigate({ to: "/new", search: draftSearch(activeProjectId ?? undefined) });
          return;
        case "project.open":
          void actions.chooseProject();
          return;
        case "layout.sidebar.toggle":
          toggleSidebar();
          return;
        case "app.settings.open":
          void navigate({ to: "/settings/personalization", search: settingsSearch });
          return;
        case "app.shortcuts.open":
          void navigate({ to: "/settings/keyboard", search: settingsSearch });
      }
    },
    [actions, activeProjectId, matchRoute, navigate, routeSearch, toggleSidebar],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const shortcut = keyboardShortcutFromEvent(event, window.desktop.platform);
      if (!shortcut || event.defaultPrevented) return;
      const shortcutKey = keyboardShortcutKey(shortcut);
      const command = KEYBOARD_COMMANDS.find(
        (candidate) =>
          (candidate.allowInEditable || !isEditableKeyboardTarget(event.target)) &&
          effectiveKeyboardShortcuts(candidate, bindings).some(
            (binding) => keyboardShortcutKey(binding) === shortcutKey,
          ),
      );
      if (!command) return;
      event.preventDefault();
      execute(command.id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bindings, execute]);

  const value = useMemo(
    () => ({ commands: KEYBOARD_COMMANDS, bindings, getBindings, setBindings, resetAll }),
    [bindings, getBindings, resetAll, setBindings],
  );

  return <KeyboardShortcutContext.Provider value={value}>{children}</KeyboardShortcutContext.Provider>;
}

export function useKeyboardShortcuts(): KeyboardShortcutContextValue {
  const value = useContext(KeyboardShortcutContext);
  if (!value) throw new Error("useKeyboardShortcuts must be used inside KeyboardShortcutProvider");
  return value;
}
