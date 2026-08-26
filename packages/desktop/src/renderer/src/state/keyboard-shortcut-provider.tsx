import { useMatchRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useDesktopActions, useDesktopSelector } from "./desktop-context.tsx";
import {
  DESKTOP_SESSION_TAB_COMMAND_IDS,
  effectiveKeyboardShortcuts,
  isEditableKeyboardTarget,
  isSessionTabCommand,
  KEYBOARD_COMMANDS,
  type KeyboardCommandId,
  type KeyboardShortcut,
  type KeyboardShortcutOverrides,
  keyboardShortcutFromEvent,
  keyboardShortcutKey,
  readKeyboardShortcutConfig,
  sessionTabTargetForCommand,
  writeKeyboardShortcutConfig,
} from "./keyboard-shortcuts.ts";
import { useLayout } from "./layout.tsx";
import { useSessionCacheRecords } from "./session-cache-context.tsx";
import { draftSearch } from "./session-navigation.ts";
import { validateSettingsSearch } from "./settings-navigation.ts";

interface KeyboardShortcutContextValue {
  commands: typeof KEYBOARD_COMMANDS;
  bindings: KeyboardShortcutOverrides;
  commandTargets: ReadonlyMap<KeyboardCommandId, string>;
  primaryModifierPressed: boolean;
  getBindings(commandId: KeyboardCommandId): readonly KeyboardShortcut[];
  setBindings(commandId: KeyboardCommandId, bindings: KeyboardShortcut[] | null): void;
  registerCommandHandler(commandId: KeyboardCommandId, handler: () => void, target?: string): () => void;
  resetAll(): void;
}

const KeyboardShortcutContext = createContext<KeyboardShortcutContextValue | null>(null);

export function KeyboardShortcutProvider({ children }: { children: ReactNode }) {
  const [bindings, setBindingsState] = useState(() => readKeyboardShortcutConfig().bindings);
  const [registeredCommandTargets, setRegisteredCommandTargets] = useState<ReadonlyMap<KeyboardCommandId, string>>(
    () => new Map(),
  );
  const [primaryModifierPressed, setPrimaryModifierPressed] = useState(false);
  const commandHandlersRef = useRef(new Map<KeyboardCommandId, () => void>());
  const activeProjectId = useDesktopSelector((state) => state.activeProjectId);
  const actions = useDesktopActions();
  const { toggleSidebar } = useLayout();
  const matchRoute = useMatchRoute();
  const navigate = useNavigate();
  const routeSearch = useSearch({ strict: false });
  const sessionRecords = useSessionCacheRecords();
  const commandTargets = useMemo(() => {
    const targets = new Map<KeyboardCommandId, string>();
    for (const [index, commandId] of DESKTOP_SESSION_TAB_COMMAND_IDS.entries()) {
      const target = sessionRecords[index]?.key;
      if (target) targets.set(commandId, target);
    }
    for (const [commandId, target] of registeredCommandTargets) targets.set(commandId, target);
    return targets;
  }, [registeredCommandTargets, sessionRecords]);

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

  const registerCommandHandler = useCallback((commandId: KeyboardCommandId, handler: () => void, target?: string) => {
    commandHandlersRef.current.set(commandId, handler);
    if (target) {
      setRegisteredCommandTargets((current) => {
        if (current.get(commandId) === target) return current;
        const next = new Map(current);
        next.set(commandId, target);
        return next;
      });
    }
    return () => {
      if (commandHandlersRef.current.get(commandId) !== handler) return;
      commandHandlersRef.current.delete(commandId);
      if (target) {
        setRegisteredCommandTargets((current) => {
          if (current.get(commandId) !== target) return current;
          const next = new Map(current);
          next.delete(commandId);
          return next;
        });
      }
    };
  }, []);

  const execute = useCallback(
    (commandId: KeyboardCommandId): boolean => {
      const registeredHandler = commandHandlersRef.current.get(commandId);
      if (registeredHandler) {
        registeredHandler();
        return true;
      }
      const sessionTabTarget = sessionTabTargetForCommand(commandId, sessionRecords);
      if (isSessionTabCommand(commandId)) {
        if (!sessionTabTarget) return false;
        void navigate({
          to: "/projects/$projectId/session/$threadId",
          params: sessionTabTarget.identity,
        });
        return true;
      }
      const sessionRoute = matchRoute({ to: "/projects/$projectId/session/$threadId", fuzzy: false });
      const settingsSearch = sessionRoute
        ? { returnProjectId: sessionRoute.projectId, returnThreadId: sessionRoute.threadId }
        : validateSettingsSearch(routeSearch);
      switch (commandId) {
        case "task.new":
          void navigate({ to: "/new", search: draftSearch(activeProjectId ?? undefined) });
          return true;
        case "project.open":
          void actions.chooseProject();
          return true;
        case "layout.sidebar.toggle":
          toggleSidebar();
          return true;
        case "app.settings.open":
          void navigate({ to: "/settings/personalization", search: settingsSearch });
          return true;
        case "app.shortcuts.open":
          void navigate({ to: "/settings/keyboard", search: settingsSearch });
          return true;
      }
      return false;
    },
    [actions, activeProjectId, matchRoute, navigate, routeSearch, sessionRecords, toggleSidebar],
  );

  useEffect(() => {
    const modifierKey = window.desktop.platform === "darwin" ? "Meta" : "Control";
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === modifierKey) setPrimaryModifierPressed(true);
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
      if (execute(command.id)) event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === modifierKey) setPrimaryModifierPressed(false);
    };
    const onBlur = (): void => setPrimaryModifierPressed(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [bindings, execute]);

  const value = useMemo(
    () => ({
      commands: KEYBOARD_COMMANDS,
      bindings,
      commandTargets,
      primaryModifierPressed,
      getBindings,
      setBindings,
      registerCommandHandler,
      resetAll,
    }),
    [bindings, commandTargets, getBindings, primaryModifierPressed, registerCommandHandler, resetAll, setBindings],
  );

  return <KeyboardShortcutContext.Provider value={value}>{children}</KeyboardShortcutContext.Provider>;
}

export function useKeyboardShortcuts(): KeyboardShortcutContextValue {
  const value = useContext(KeyboardShortcutContext);
  if (!value) throw new Error("useKeyboardShortcuts must be used inside KeyboardShortcutProvider");
  return value;
}
