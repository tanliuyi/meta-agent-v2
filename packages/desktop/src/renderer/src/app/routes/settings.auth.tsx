import { createFileRoute, Navigate } from "@tanstack/react-router";

/** Merged into the unified providers page. */
export const Route = createFileRoute("/settings/auth")({
  component: () => <Navigate to="/settings/models" search={(prev) => prev} replace />,
});
