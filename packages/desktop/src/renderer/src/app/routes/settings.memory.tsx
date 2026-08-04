import { MemorySettingsPage } from "@renderer/features/settings/memory/memory-settings-page";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/memory")({
  component: MemorySettingsPage,
});
