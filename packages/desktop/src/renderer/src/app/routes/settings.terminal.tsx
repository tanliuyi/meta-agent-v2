import { TerminalSettingsPage } from "@renderer/features/settings/terminal/terminal-settings-page";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/terminal")({
  component: TerminalSettingsPage,
});
