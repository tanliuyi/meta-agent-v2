import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/")({
  component: () => <Navigate to="/settings/personalization" search={(previous) => previous} replace />,
});
