import { NewSessionRoute } from "@renderer/components/new-session-route";
import { validateDraftSearch } from "@renderer/state/session-navigation";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/new")({
  validateSearch: validateDraftSearch,
  component: NewSessionRoute,
});
