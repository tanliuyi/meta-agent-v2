import { SubagentSettingsPage } from "@renderer/features/settings/subagent-settings-page";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/subagents")({
  component: SubagentSettingsPage,
});
