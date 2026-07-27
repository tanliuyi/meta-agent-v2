import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/extensions")({
  component: () => <Navigate to="/plugins" search={(previous) => previous} replace />,
});
