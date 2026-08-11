import { TooltipIconButton } from "@renderer/components/assistant-ui/tooltip-icon-button";
import { Input } from "@renderer/shared/ui/input";
import { useKeyboardShortcuts } from "@renderer/state/keyboard-shortcut-provider";
import {
  formatKeyboardShortcut,
  type KeyboardCommandId,
  type KeyboardShortcut,
  keyboardShortcutKey,
} from "@renderer/state/keyboard-shortcuts";
import Pencil from "lucide-react/dist/esm/icons/pencil.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { useMemo, useState } from "react";
import { KeyboardShortcutDialog } from "./keyboard-shortcut-dialog.tsx";

interface EditingBinding {
  commandId: KeyboardCommandId;
  index: number | null;
}

export function KeyboardShortcutsSettingsPage() {
  const { commands, getBindings, setBindings, resetAll } = useKeyboardShortcuts();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<EditingBinding | null>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleCommands = commands.filter((command) => {
    if (!normalizedQuery) return true;
    const shortcuts = getBindings(command.id).map((binding) =>
      formatKeyboardShortcut(binding, window.desktop.platform),
    );
    return [command.title, command.description, ...shortcuts].some((value) =>
      value.toLocaleLowerCase().includes(normalizedQuery),
    );
  });

  const editingCommand = editing ? commands.find(({ id }) => id === editing.commandId) : undefined;
  const editingBindings = editingCommand ? [...getBindings(editingCommand.id)] : [];
  const reservedBindings = useMemo(() => {
    const reserved = new Map<string, string>();
    for (const command of commands) {
      getBindings(command.id).forEach((binding, index) => {
        if (editing?.commandId === command.id && editing.index === index) return;
        reserved.set(keyboardShortcutKey(binding), command.title);
      });
    }
    return reserved;
  }, [commands, editing, getBindings]);

  const replaceBinding = (binding: KeyboardShortcut): void => {
    if (!editingCommand || !editing) return;
    const next = [...editingBindings];
    if (editing.index === null) next.push(binding);
    else next[editing.index] = binding;
    setBindings(editingCommand.id, next);
  };

  return (
    <>
      <div className="settings-content keyboard-shortcuts-content">
        <header className="settings-page-heading keyboard-shortcuts-heading">
          <div>
            <h2>键盘快捷键</h2>
            <span>{commands.length} 个可配置命令</span>
          </div>
          <TooltipIconButton tooltip="恢复所有默认快捷键" side="bottom" onClick={resetAll}>
            <RotateCcw />
          </TooltipIconButton>
        </header>

        <div className="keyboard-shortcuts-search">
          <Search aria-hidden="true" />
          <Input
            type="search"
            value={query}
            placeholder="搜索快捷键"
            aria-label="搜索快捷键"
            style={{ paddingLeft: "2.25rem" }}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <section className="keyboard-shortcuts-list" aria-label="键盘快捷键列表">
          {visibleCommands.length > 0 ? (
            visibleCommands.map((command) => {
              const commandBindings = getBindings(command.id);
              return (
                <div className="keyboard-shortcut-row" key={command.id}>
                  <div className="keyboard-shortcut-copy">
                    <strong>{command.title}</strong>
                    <span>{command.description}</span>
                  </div>
                  <div className="keyboard-shortcut-bindings">
                    {commandBindings.length === 0 ? (
                      <div className="keyboard-shortcut-binding">
                        <span className="keyboard-shortcut-unassigned">未分配</span>
                        <TooltipIconButton
                          tooltip={`为${command.title}分配快捷键`}
                          onClick={() => setEditing({ commandId: command.id, index: null })}
                        >
                          <Pencil />
                        </TooltipIconButton>
                      </div>
                    ) : (
                      commandBindings.map((binding, index) => (
                        <div className="keyboard-shortcut-binding" key={keyboardShortcutKey(binding)}>
                          <kbd>{formatKeyboardShortcut(binding, window.desktop.platform)}</kbd>
                          <TooltipIconButton
                            tooltip={`编辑${command.title}快捷键`}
                            onClick={() => setEditing({ commandId: command.id, index })}
                          >
                            <Pencil />
                          </TooltipIconButton>
                          <TooltipIconButton
                            tooltip={`删除${command.title}快捷键`}
                            className="keyboard-shortcut-delete"
                            onClick={() => {
                              const next = commandBindings.filter((_, bindingIndex) => bindingIndex !== index);
                              setBindings(command.id, next.length > 0 ? [...next] : null);
                            }}
                          >
                            <Trash2 />
                          </TooltipIconButton>
                        </div>
                      ))
                    )}
                    {commandBindings.length > 0 ? (
                      <TooltipIconButton
                        tooltip={`为${command.title}添加快捷键`}
                        className="keyboard-shortcut-add"
                        onClick={() => setEditing({ commandId: command.id, index: null })}
                      >
                        <Plus />
                      </TooltipIconButton>
                    ) : null}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="keyboard-shortcuts-empty">没有匹配的快捷键</div>
          )}
        </section>
      </div>

      <KeyboardShortcutDialog
        commandTitle={editingCommand?.title ?? ""}
        initialBinding={editing && editing.index !== null ? (editingBindings[editing.index] ?? null) : null}
        reservedBindings={reservedBindings}
        open={Boolean(editingCommand)}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSave={replaceBinding}
      />
    </>
  );
}
