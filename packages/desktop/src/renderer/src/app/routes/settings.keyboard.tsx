import { KeyboardShortcutsSettingsPage } from "@renderer/features/settings/keyboard/keyboard-shortcuts-settings-page";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/keyboard")({
  component: KeyboardShortcutsSettingsPage,
});
